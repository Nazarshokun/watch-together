const $ = id => document.getElementById(id);
let tab = null;

const call = (cmd, extra = {}) => chrome.runtime.sendMessage({ kind: 'popup', cmd, tabId: tab && tab.id, ...extra });

function render(S) {
  if (!S) return;
  const inRoom = !!S.role;
  $('idle').hidden = inRoom;
  $('room').hidden = !inRoom;
  $('err').hidden = !S.error;
  $('err').textContent = S.error || '';
  if (!inRoom) return;

  $('roleLabel').textContent = S.role === 'host' ? 'Your room. Send this code to friends:' : 'Joined room';
  $('roomCode').textContent = S.code;
  $('copy').hidden = S.role !== 'host';

  const ok = S.status === 'hosting' || S.status === 'connected';
  $('dot').className = 'dot' + (ok ? ' ok' : S.status === 'error' ? ' bad' : '');
  const people = S.peers + 1;
  $('statusText').textContent = {
    starting: 'Opening room…',
    connecting: 'Connecting to host…',
    hosting: people === 1 ? 'Waiting for friends…' : `${people} people watching`,
    connected: `Connected · ${people} people watching`,
    error: 'Problem',
  }[S.status] || S.status;

  const differentTab = tab && S.tabId !== tab.id;
  $('otherTab').hidden = !differentTab;

  const showHost = S.role === 'guest' && S.hostUrl && !differentTab && tab && tab.url !== S.hostUrl;
  $('hostPage').hidden = !showHost;
  if (showHost) $('hostTitle').textContent = S.hostTitle || S.hostUrl;
}

async function act(cmd, extra) {
  const r = await call(cmd, extra);
  if (r && r.error && !r.role) { $('err').hidden = false; $('err').textContent = r.error; return; }
  render(r);
}

$('host').onclick = () => act('host');
$('join').onclick = () => act('join', { code: $('code').value });
$('code').addEventListener('keydown', e => { if (e.key === 'Enter') $('join').click(); });
$('leave').onclick = () => act('leave');
$('openHost').onclick = () => act('openHostPage');
$('useTab').onclick = () => act('useThisTab');
$('copy').onclick = async () => {
  const S = await call('status');
  const tabNow = await chrome.tabs.get(S.tabId).catch(() => null);
  const text = `Watch with me in the Watch Together extension.\nRoom code: ${S.code}\n${tabNow ? tabNow.url : ''}`;
  await navigator.clipboard.writeText(text);
  $('copy').textContent = 'Copied ✓';
  setTimeout(() => ($('copy').textContent = 'Copy invite'), 1500);
};

chrome.runtime.onMessage.addListener(m => { if (m && m.kind === 'statusChanged') render(m.S); });

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  render(await call('status'));
})();
