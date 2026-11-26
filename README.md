# Watch Together

Chrome extension that keeps a video in sync between friends on any website
(rezka, YouTube, anything with an HTML `<video>`): play, pause, seek and speed.
Each person streams the video on their own computer; only the controls are shared,
peer-to-peer (WebRTC via PeerJS; the free 0.peerjs.com server only introduces the peers).
Talk over FaceTime, Telegram, Discord, whatever you like.

## Install (each person)
1. Chrome → `chrome://extensions` → turn on **Developer mode** (top right).
2. **Load unpacked** → choose this folder.
3. Pin the extension (puzzle icon → pin).

Friends need this folder too: zip it and send it, they load it the same way.
(Works in Chrome, Edge, Brave, Arc, any Chromium browser. Not in Safari.)

## Use
- Host: open the video page → extension icon → **Start a room on this tab** → **Copy invite** → send it.
- Friend: open the same page (or any page, then **Open the same page**) → extension icon →
  paste the code or the whole invite → **Join**.
- Anyone can play/pause/seek. A friend who reloads or arrives late is caught up within ~3 s.
- If Chrome blocks autoplay for a friend, a note appears on the page: click it once.
- Badge on the icon = number of people in the room. **Leave room** to stop.

## Limits
- Ads that play inside the same player can make one side jump; skip them before starting.
- Sites whose player hides the video in a closed shadow root or a canvas cannot be synced.
- DRM sites (Netflix etc.) sync fine, but everyone needs their own account.
