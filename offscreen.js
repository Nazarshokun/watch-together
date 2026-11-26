// Watch Together: the peer-to-peer link (PeerJS / WebRTC). Star topology:
// the host's peer id is the room code; guests connect to it and the host
// relays every message to the other guests.

let peer = null;
let role = null;
let hostConn = null;
const conns = new Map();

function toBg(msg) {
  chrome.runtime.sendMessage({ target: 'bg', ...msg }).catch(() => {});
}

function reset() {
  for (const c of conns.values()) { try { c.close(); } catch {} }
  conns.clear();
  if (hostConn) { try { hostConn.close(); } catch {} hostConn = null; }
  if (peer) { try { peer.destroy(); } catch {} peer = null; }
  role = null;
}

function describe(e) {
  switch (e.type) {
    case 'peer-unavailable': return 'Room not found. Check the code, or ask the host to keep their popup room open.';
    case 'unavailable-id': return 'That room code is already in use. Leave and start a new room.';
    case 'network': case 'server-error': case 'socket-error': case 'socket-closed':
      return 'Cannot reach the connection server (0.peerjs.com). Check your internet.';
    case 'webrtc': return 'Direct connection failed (network blocks WebRTC).';
    default: return e.message || String(e);
  }
}

function common(p) {
  p.on('error', e => toBg({ ev: 'status', status: 'error', error: describe(e) }));
  p.on('disconnected', () => {
    // Lost the signalling server only; existing peer links keep working.
    if (!p.destroyed) setTimeout(() => { try { p.reconnect(); } catch {} }, 2000);
  });
}

function host(id) {
  reset();
  role = 'host';
  const p = peer = new Peer(id, { debug: 1 });
  p.on('open', () => toBg({ ev: 'status', status: 'hosting' }));
  p.on('connection', c => {
    c.on('open', () => {
      conns.set(c.connectionId, c);
      toBg({ ev: 'peers', n: conns.size });
      toBg({ ev: 'peerJoined', connId: c.connectionId });
    });
    c.on('data', d => {
      for (const [cid, o] of conns) if (cid !== c.connectionId && o.open) o.send(d);
      toBg({ ev: 'remote', data: d });
    });
    const gone = () => { if (conns.delete(c.connectionId)) toBg({ ev: 'peers', n: conns.size }); };
    c.on('close', gone);
    c.on('error', gone);
  });
  common(p);
}

function join(id) {
  reset();
  role = 'guest';
  const p = peer = new Peer({ debug: 1 });
  p.on('open', () => {
    const c = hostConn = p.connect(id, { reliable: true });
    const timer = setTimeout(() => {
      if (!c.open) toBg({ ev: 'status', status: 'error', error: 'No answer from the host. Check the code.' });
    }, 20000);
    c.on('open', () => { clearTimeout(timer); toBg({ ev: 'status', status: 'connected' }); });
    c.on('data', d => toBg({ ev: 'remote', data: d }));
    c.on('close', () => {
      if (hostConn === c) toBg({ ev: 'status', status: 'error', error: 'The host closed the room.' });
    });
  });
  common(p);
}

chrome.runtime.onMessage.addListener((m, _sender, send) => {
  if (!m || m.target !== 'offscreen') return false;
  switch (m.cmd) {
    case 'host': host(m.id); break;
    case 'join': join(m.id); break;
    case 'leave': reset(); break;
    case 'broadcast':
      if (role === 'host') { for (const c of conns.values()) if (c.open) c.send(m.data); }
      else if (hostConn && hostConn.open) hostConn.send(m.data);
      break;
    case 'sendTo': { const c = conns.get(m.connId); if (c && c.open) c.send(m.data); break; }
  }
  send({ ok: true });
  return false;
});
