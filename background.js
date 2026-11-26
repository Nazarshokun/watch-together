// Watch Together: service worker. Holds the room state, routes messages
// between the popup, the page (content.js) and the peer connection (offscreen.js).

const PREFIX = 'wtogether-';
const DEFAULT = {
  tabId: null, role: null, code: null, status: 'idle', peers: 0,
  hostUrl: null, hostTitle: null, error: null,
};
let S = null;

async function load() {
  if (!S) {
    const r = await chrome.storage.session.get('S');
    S = Object.assign({}, DEFAULT, r.S || {});
  }
  return S;
}

async function save(patch) {
  await load();
  Object.assign(S, patch);
  await chrome.storage.session.set({ S });
  chrome.runtime.sendMessage({ kind: 'statusChanged', S }).catch(() => {});
  updateBadge();
}

function updateBadge() {
  const inRoom = !!S.role;
  chrome.action.setBadgeText({ text: inRoom ? String(S.peers + 1) : '' });
  const ok = S.status === 'hosting' || S.status === 'connected';
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#1a7f37' : S.status === 'error' ? '#cf222e' : '#9a6700' });
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WEB_RTC'],
    justification: 'Peer-to-peer connection that keeps video playback in sync between friends',
  });
}

async function toOffscreen(msg) {
  await ensureOffscreen();
  for (let i = 0; i < 30; i++) {
    try { return await chrome.runtime.sendMessage({ target: 'offscreen', ...msg }); }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
}

function toTab(msg) {
  if (S.tabId == null) return Promise.resolve();
  return chrome.tabs.sendMessage(S.tabId, msg).catch(() => undefined);
}

function newCode() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const a = crypto.getRandomValues(new Uint8Array(6));
  return [...a].map(x => abc[x % abc.length]).join('');
}

async function leave() {
  await load();
  if (S.tabId != null) await toTab({ kind: 'setActive', active: false });
  if (await chrome.offscreen.hasDocument()) {
    await toOffscreen({ cmd: 'leave' });
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  await save({ ...DEFAULT });
}

async function welcomeFor() {
  const tab = await chrome.tabs.get(S.tabId).catch(() => null);
  const state = await toTab({ kind: 'getState' });
  return { type: 'welcome', url: tab?.url, title: tab?.title, state, peers: S.peers + 1 };
}

async function handle(m, sender) {
  await load();

  // ---- from the popup ----
  if (m.kind === 'popup') {
    switch (m.cmd) {
      case 'status': return S;
      case 'host': {
        if (S.role) await leave();
        const code = newCode();
        await save({ tabId: m.tabId, role: 'host', code, status: 'starting', peers: 0, error: null });
        await toTab({ kind: 'setActive', active: true, role: 'host' });
        await toOffscreen({ cmd: 'host', id: PREFIX + code });
        return S;
      }
      case 'join': {
        // Accept the bare code or the whole pasted invite text.
        const raw = String(m.code || '');
        const hit = /room code:\s*([a-z0-9]{6})\b/i.exec(raw) || /^\s*([a-z0-9]{6})\s*$/i.exec(raw);
        if (!hit) return { error: 'Paste the 6-character room code (or the whole invite).' };
        const code = hit[1].toLowerCase();
        if (S.role) await leave();
        await save({ tabId: m.tabId, role: 'guest', code, status: 'connecting', peers: 0, error: null });
        await toTab({ kind: 'setActive', active: true, role: 'guest' });
        await toOffscreen({ cmd: 'join', id: PREFIX + code });
        return S;
      }
      case 'leave': await leave(); return S;
      case 'openHostPage':
        if (S.hostUrl && S.tabId != null) {
          await chrome.tabs.update(S.tabId, { url: S.hostUrl, active: true });
        }
        return S;
      case 'useThisTab':
        await toTab({ kind: 'setActive', active: false });
        await save({ tabId: m.tabId });
        await toTab({ kind: 'setActive', active: true, role: S.role });
        return S;
    }
    return S;
  }

  // ---- from the peer connection (offscreen) ----
  if (m.target === 'bg') {
    if (!S.role) return;
    switch (m.ev) {
      case 'status': await save({ status: m.status, error: m.error || null }); break;
      case 'peers':
        await save({ peers: m.n });
        if (S.role === 'host') toOffscreen({ cmd: 'broadcast', data: { type: 'peers', n: m.n + 1 } });
        break;
      case 'peerJoined':
        if (S.role === 'host') await toOffscreen({ cmd: 'sendTo', connId: m.connId, data: await welcomeFor() });
        break;
      case 'remote': await onRemote(m.data); break;
    }
    return;
  }

  // ---- from a page (content.js) ----
  if (m.kind === 'hello') {
    const mine = !!S.role && sender.tab && sender.tab.id === S.tabId;
    return { active: mine, role: S.role };
  }
  if (!S.role || !sender.tab || sender.tab.id !== S.tabId) return;
  if (m.kind === 'local') {
    await toOffscreen({ cmd: 'broadcast', data: { type: 'state', state: m.state } });
  } else if (m.kind === 'tick' && S.role === 'host') {
    await toOffscreen({ cmd: 'broadcast', data: { type: 'sync', state: m.state } });
  }
}

async function onRemote(d) {
  if (!d || typeof d !== 'object') return;
  switch (d.type) {
    case 'welcome':
      await save({ hostUrl: d.url || null, hostTitle: d.title || null, peers: Math.max(0, (d.peers || 1) - 1) });
      if (d.state) await toTab({ kind: 'apply', state: d.state, strict: true, quiet: true });
      break;
    case 'url':
      await save({ hostUrl: d.url || null, hostTitle: d.title || null });
      break;
    case 'peers':
      if (S.role === 'guest') await save({ peers: Math.max(0, d.n - 1) });
      break;
    case 'state':
      await toTab({ kind: 'apply', state: d.state, strict: true });
      break;
    case 'sync':
      await toTab({ kind: 'apply', state: d.state, strict: false });
      break;
  }
}

chrome.runtime.onMessage.addListener((m, sender, send) => {
  if (m && m.target === 'offscreen') return false;
  if (m && m.kind === 'statusChanged') return false;
  handle(m, sender).then(send, e => send({ error: String(e && e.message || e) }));
  return true;
});

chrome.tabs.onRemoved.addListener(async tabId => {
  await load();
  if (S.role && tabId === S.tabId) await leave();
});

// Tell guests when the host moves to another page (e.g. the next episode).
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  await load();
  if (S.role !== 'host' || tabId !== S.tabId || !info.url) return;
  await toOffscreen({ cmd: 'broadcast', data: { type: 'url', url: info.url, title: tab.title } });
});

chrome.runtime.onStartup.addListener(() => chrome.storage.session.clear());
