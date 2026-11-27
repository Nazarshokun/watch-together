// Watch Together: a minimal MQTT 3.1.1 client over WebSocket (QoS 0 only).
// Enough to publish and subscribe on a public broker; no dependencies.

const BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

const enc = new TextEncoder();
const dec = new TextDecoder();

function str(s) {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 255, ...b];
}

function packet(type, body) {
  const len = [];
  let n = body.length;
  do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 128; len.push(d); } while (n);
  return new Uint8Array([type, ...len, ...body]);
}

class Mqtt {
  // handlers: { onMessage(topic, text), onUp(), onDown() }
  constructor(handlers, url) {
    this.h = handlers;
    this.url = url;
    this.subs = new Set();
    this.ws = null;
    this.up = false;
    this.closed = false;
    this.buf = new Uint8Array(0);
    this.pid = 1;
    this.connect();
  }

  connect() {
    if (this.closed) return;
    this.buf = new Uint8Array(0);
    let ws;
    try { ws = this.ws = new WebSocket(this.url, 'mqtt'); }
    catch { return this.retry(); }
    ws.binaryType = 'arraybuffer';
    const timeout = setTimeout(() => { if (!this.up) ws.close(); }, 8000);
    ws.onopen = () => {
      const id = 'wt' + Math.random().toString(36).slice(2, 12);
      // CONNECT: protocol "MQTT" level 4, clean session, keepalive 60 s.
      ws.send(packet(0x10, [...str('MQTT'), 4, 0x02, 0, 60, ...str(id)]));
    };
    ws.onmessage = e => this.feed(new Uint8Array(e.data));
    ws.onclose = ws.onerror = () => {
      clearTimeout(timeout);
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.ping);
      const wasUp = this.up;
      this.up = false;
      if (wasUp) this.h.onDown && this.h.onDown();
      this.retry();
    };
  }

  retry() {
    if (!this.closed) setTimeout(() => this.connect(), 2000);
  }

  feed(bytes) {
    const b = new Uint8Array(this.buf.length + bytes.length);
    b.set(this.buf); b.set(bytes, this.buf.length);
    let i = 0;
    while (i < b.length) {
      let len = 0, mul = 1, j = i + 1, d;
      do {
        if (j >= b.length) { this.buf = b.slice(i); return; }
        d = b[j++]; len += (d & 127) * mul; mul *= 128;
      } while (d & 128);
      if (j + len > b.length) break;
      this.packetIn(b[i], b.subarray(j, j + len));
      i = j + len;
    }
    this.buf = b.slice(i);
  }

  packetIn(type, body) {
    switch (type >> 4) {
      case 2: // CONNACK
        if (body[1] !== 0) { this.ws.close(); return; }
        this.up = true;
        for (const t of this.subs) this.sendSub(t);
        this.ping = setInterval(() => this.raw(new Uint8Array([0xc0, 0])), 30000);
        this.h.onUp && this.h.onUp();
        break;
      case 3: { // PUBLISH (QoS 0, so no packet id)
        const tl = (body[0] << 8) | body[1];
        const topic = dec.decode(body.subarray(2, 2 + tl));
        const qos = (type >> 1) & 3;
        const start = 2 + tl + (qos ? 2 : 0);
        this.h.onMessage(topic, dec.decode(body.subarray(start)));
        break;
      }
    }
  }

  raw(p) {
    if (this.ws && this.ws.readyState === 1) { this.ws.send(p); return true; }
    return false;
  }

  sendSub(topic) {
    const id = this.pid++ & 0xffff || 1;
    this.raw(packet(0x82, [id >> 8, id & 255, ...str(topic), 0]));
  }

  subscribe(topic) {
    this.subs.add(topic);
    if (this.up) this.sendSub(topic);
  }

  publish(topic, text) {
    if (!this.up) return false;
    return this.raw(packet(0x30, [...str(topic), ...enc.encode(text)]));
  }

  close() {
    this.closed = true;
    clearInterval(this.ping);
    if (this.ws) { this.raw(new Uint8Array([0xe0, 0])); const ws = this.ws; setTimeout(() => { try { ws.close(); } catch {} }, 300); }
    this.ws = null;
    this.up = false;
  }
}

// Talks through every broker at once, so two people meet even when one of them
// cannot reach some broker. Each message carries an id; duplicates are dropped.
class Relay {
  constructor(handlers) {
    this.h = handlers;
    this.seen = new Map();
    this.n = 0;
    this.tag = Math.random().toString(36).slice(2, 8);
    const up = () => this.links.filter(l => l.up).length;
    this.links = BROKERS.map(url => new Mqtt({
      onUp: () => { if (up() === 1) handlers.onUp && handlers.onUp(); },
      onDown: () => { if (up() === 0) handlers.onDown && handlers.onDown(); },
      onMessage: (topic, text) => {
        const cut = text.indexOf('|');
        if (cut < 0) return;
        const id = text.slice(0, cut);
        if (this.seen.has(id)) return;
        this.seen.set(id, Date.now());
        if (this.seen.size > 500) for (const [k, t] of this.seen) if (Date.now() - t > 60000) this.seen.delete(k);
        handlers.onMessage(topic, text.slice(cut + 1));
      },
    }, url));
  }
  get up() { return this.links.some(l => l.up); }
  subscribe(topic) { this.links.forEach(l => l.subscribe(topic)); }
  publish(topic, text) {
    const msg = this.tag + (this.n++).toString(36) + '|' + text;
    return this.links.map(l => l.publish(topic, msg)).some(Boolean);
  }
  close() { this.links.forEach(l => l.close()); }
}

if (typeof module !== 'undefined') module.exports = { Mqtt, Relay, BROKERS };
