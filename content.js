// Watch Together: runs in every frame. Watches the page's <video> for
// play / pause / seek / speed changes and applies the ones that come from friends.
(() => {
  if (window.__watchTogether) return;
  window.__watchTogether = true;

  let active = false;
  let role = null;
  let current = null;       // the video the user last touched
  let expected = null;      // last state we synced to: {playing, time, rate, at}
  let suppressUntil = 0;    // ignore our own echoes right after applying a remote change
  let tickTimer = null;

  const now = () => performance.now();
  const isVideo = el => el && el.tagName === 'VIDEO';

  function allVideos(root = document) {
    const out = [...root.querySelectorAll('video')];
    // open shadow roots (some custom players)
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) out.push(...allVideos(el.shadowRoot));
    return out;
  }

  function pick() {
    if (current && current.isConnected) return current;
    let best = null, bestArea = 0;
    for (const v of allVideos()) {
      const r = v.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > bestArea) { bestArea = a; best = v; }
    }
    return best;
  }

  const stateOf = v => ({ playing: !v.paused && !v.ended, time: v.currentTime, rate: v.playbackRate });

  function expectedTime() {
    if (!expected) return null;
    return expected.playing ? expected.time + ((now() - expected.at) / 1000) * expected.rate : expected.time;
  }

  function isEcho(v) {
    if (now() < suppressUntil) return true;
    if (!expected) return false;
    const s = stateOf(v);
    return s.playing === expected.playing && s.rate === expected.rate && Math.abs(s.time - expectedTime()) < 1.0;
  }

  function send(msg) {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch { /* extension reloaded */ }
  }

  // Media events don't bubble, but they do pass the capture phase on document.
  for (const type of ['play', 'pause', 'seeked', 'ratechange']) {
    document.addEventListener(type, e => {
      const v = e.target;
      if (!active || !isVideo(v)) return;
      const r = v.getBoundingClientRect();
      if (r.width * r.height < 200 * 100 && v !== current) return; // thumbnails, previews
      current = v;
      if (isEcho(v)) return;
      const s = stateOf(v);
      expected = { ...s, at: now() };
      send({ kind: 'local', state: s });
    }, true);
  }

  async function apply(s, strict, quiet) {
    const v = pick();
    if (!v || !s) return;
    const cur = stateOf(v);
    const drift = Math.abs(cur.time - s.time);
    const limit = strict ? 0.5 : 1.5;
    expected = { ...s, at: now() };
    if (!strict && cur.playing === s.playing && cur.rate === s.rate && drift < limit) return;

    suppressUntil = now() + 800;
    if (v.playbackRate !== s.rate) v.playbackRate = s.rate;
    if (drift > limit) v.currentTime = s.time;
    if (s.playing && v.paused) {
      try { await v.play(); }
      catch {
        toast('A friend pressed play. Click here to start the video.', () => { v.play().catch(() => {}); });
        return;
      }
    } else if (!s.playing && !v.paused) {
      v.pause();
    }
    if (strict && !quiet) toast(`${s.playing ? '▶ Play' : '⏸ Pause'} at ${fmt(s.time)}`);
  }

  function fmt(t) {
    t = Math.max(0, Math.floor(t));
    const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, sec = t % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
  }

  let toastEl = null, toastTimer = null;
  function toast(text, onClick) {
    if (toastEl) toastEl.remove();
    const el = toastEl = document.createElement('div');
    el.textContent = text;
    Object.assign(el.style, {
      position: 'fixed', zIndex: 2147483647, left: '50%', top: '24px', transform: 'translateX(-50%)',
      background: 'rgba(20,20,24,.88)', color: '#fff', font: '600 14px/1.3 system-ui, sans-serif',
      padding: '10px 16px', borderRadius: '10px', boxShadow: '0 4px 20px rgba(0,0,0,.35)',
      cursor: onClick ? 'pointer' : 'default', pointerEvents: onClick ? 'auto' : 'none', maxWidth: '80vw',
    });
    if (onClick) el.addEventListener('click', () => { onClick(); el.remove(); }, { once: true });
    (document.fullscreenElement || document.body || document.documentElement).appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), onClick ? 15000 : 2200);
  }

  function setActive(on, r) {
    const was = active;
    active = !!on;
    role = r || null;
    clearInterval(tickTimer);
    tickTimer = null;
    if (active && role === 'host') {
      // Heartbeat: guests correct drift from this.
      tickTimer = setInterval(() => {
        const v = pick();
        if (!v || v.readyState < 1) return;
        if (v !== current && !(v.duration > 60)) return;
        send({ kind: 'tick', state: stateOf(v) });
      }, 3000);
    }
    if (active && !was && window === window.top) toast(role === 'host' ? 'Watch Together: room open' : 'Watch Together: joined');
  }

  chrome.runtime.onMessage.addListener((m, _sender, sendResponse) => {
    if (!m) return false;
    if (m.kind === 'setActive') setActive(m.active, m.role);
    else if (m.kind === 'apply' && active) apply(m.state, m.strict, m.quiet);
    else if (m.kind === 'getState') {
      const v = pick();
      if (v && v.readyState >= 1) sendResponse(stateOf(v)); // frames without a video stay silent
    }
    return false;
  });

  // After a page load or navigation inside the room's tab, rejoin automatically.
  try {
    chrome.runtime.sendMessage({ kind: 'hello' }).then(r => { if (r && r.active) setActive(true, r.role); }).catch(() => {});
  } catch {}
})();
