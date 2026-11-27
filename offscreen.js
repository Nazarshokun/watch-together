// Watch Together: the room link. Messages travel through a public MQTT broker
// (see mqtt.js; several at once), so it works on any network, behind any router.
//
// Topics, under wtogether/v2/<room code>:
//   /all      host -> everyone   (host's own messages and relayed guest messages)
//   /host     guest -> host
//   /to/<id>  host -> one guest  (the welcome)
// Every message is JSON: { t: 'hello'|'ping'|'data'|'bye', from, d? }.

const HEARTBEAT = 5000;     // everyone pings this often
const GONE_AFTER = 16000;   // silent this long = left
const WELCOME_WAIT = 15000; // guest gives up on a host that never answers

let link = null;   // Relay
let role = null;
let base = null;
let me = null;
let timers = [];
const guests = new Map();  // host: guest id -> last seen (ms)
let hostSeen = 0;          // guest: last message from the host
let welcomed = false;      // guest: got a welcome since the last (re)connect

function toBg(msg) {
  chrome.runtime.sendMessage({ target: 'bg', ...msg }).catch(() => {});
}

function pub(topic, msg) {
  return link && link.publish(base + topic, JSON.stringify({ ...msg, from: me }));
}

function every(ms, fn) { timers.push(setInterval(fn, ms)); }
function after(ms, fn) { timers.push(setTimeout(fn, ms)); }

function reset() {
  if (link) {
    if (role === 'host') pub('/all', { t: 'bye' });
    link.close();  // the goodbye is sent before the socket closes
  }
  link = null;
  timers.forEach(t => { clearInterval(t); clearTimeout(t); });
  timers = [];
  guests.clear();
  role = null;
  welcomed = false;
  hostSeen = 0;
}

function parse(text) {
  try { const m = JSON.parse(text); return m && typeof m === 'object' && m.from ? m : null; }
  catch { return null; }
}

function host(id) {
  reset();
  role = 'host';
  base = 'wtogether/v2/' + id;
  me = 'host';
  link = new Relay({
    onUp: () => toBg({ ev: 'status', status: 'hosting' }),
    onDown: () => toBg({ ev: 'status', status: 'starting' }),
    onMessage: (topic, text) => {
      const m = parse(text);
      if (!m || topic !== base + '/host') return;
      const isNew = !guests.has(m.from);
      guests.set(m.from, Date.now());
      if (m.t === 'hello') {
        if (isNew) toBg({ ev: 'peers', n: guests.size });
        toBg({ ev: 'peerJoined', connId: m.from });   // background answers with a welcome
      } else if (m.t === 'data') {
        if (isNew) toBg({ ev: 'peers', n: guests.size });
        pub('/all', { t: 'data', d: m.d, via: m.from });  // relay to the other guests
        toBg({ ev: 'remote', data: m.d });
      } else if (m.t === 'bye') {
        if (guests.delete(m.from)) toBg({ ev: 'peers', n: guests.size });
      }
    },
  });
  link.subscribe(base + '/host');
  every(HEARTBEAT, () => {
    pub('/all', { t: 'ping' });
    const now = Date.now();
    let changed = false;
    for (const [g, seen] of guests) if (now - seen > GONE_AFTER) { guests.delete(g); changed = true; }
    if (changed) toBg({ ev: 'peers', n: guests.size });
  });
}

function join(id) {
  reset();
  role = 'guest';
  base = 'wtogether/v2/' + id;
  me = 'g' + Math.random().toString(36).slice(2, 10);
  const hello = () => { if (!welcomed) pub('/host', { t: 'hello' }); };

  link = new Relay({
    onUp: () => {
      welcomed = false;
      hello();
      const startedAt = Date.now();
      after(WELCOME_WAIT, () => {
        if (!welcomed && hostSeen < startedAt) {
          toBg({ ev: 'status', status: 'error', error: 'No answer from the host. Check the code, and that the host still has the room open.' });
        }
      });
    },
    onDown: () => toBg({ ev: 'status', status: 'connecting' }),
    onMessage: (topic, text) => {
      const m = parse(text);
      if (!m || m.from !== 'host') return;
      hostSeen = Date.now();
      if (topic === base + '/to/' + me && m.t === 'data') {
        if (!welcomed) { welcomed = true; toBg({ ev: 'status', status: 'connected' }); }
        toBg({ ev: 'remote', data: m.d });
      } else if (topic === base + '/all') {
        if (m.t === 'bye') { toBg({ ev: 'status', status: 'error', error: 'The host closed the room.' }); return; }
        if (m.t === 'data' && m.via !== me) toBg({ ev: 'remote', data: m.d });
        if (!welcomed) hello();   // host is there but missed our hello
      }
    },
  });
  link.subscribe(base + '/all');
  link.subscribe(base + '/to/' + me);
  every(HEARTBEAT, () => {
    pub('/host', { t: welcomed ? 'ping' : 'hello' });
    if (welcomed && Date.now() - hostSeen > GONE_AFTER) {
      welcomed = false;
      toBg({ ev: 'status', status: 'connecting' });
      hello();
    }
    if (!welcomed && hostSeen && Date.now() - hostSeen > 30000) {
      toBg({ ev: 'status', status: 'error', error: 'Lost contact with the host.' });
    }
  });
}

chrome.runtime.onMessage.addListener((m, _sender, send) => {
  if (!m || m.target !== 'offscreen') return false;
  switch (m.cmd) {
    case 'host': host(m.id); break;
    case 'join': join(m.id); break;
    case 'leave':
      if (role === 'guest') pub('/host', { t: 'bye' });
      reset();
      break;
    case 'broadcast':
      if (role === 'host') pub('/all', { t: 'data', d: m.data });
      else pub('/host', { t: 'data', d: m.data });
      break;
    case 'sendTo':
      if (role === 'host') pub('/to/' + m.connId, { t: 'data', d: m.data });
      break;
  }
  send({ ok: true });
  return false;
});
