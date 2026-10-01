# Tesla Video Drive

Stream live video in your Tesla while driving — bypassing the Drive Mode browser restriction.

A diagnostic **probe** to map Tesla browser capabilities + a fully-functional **Twitch live stream client** using only what the embedded Chromium provides.

**Disclaimer**: Watching video while driving is **dangerous and illegal** in most jurisdictions. This project is purely a technical research exercise to explore the limits of Tesla's Drive Mode browser restrictions. Do not use it while operating a vehicle. The author assumes no responsibility for misuse.

---

## Background

The Tesla browser runs on **QtWebEngine** (embedded Chromium). It is accessible in both Park and Drive modes — but with restrictions:

- `<video>` elements are **paused** immediately in Drive (last frame frozen, audio continues)
- `getUserMedia` returns an error (microphone blocked at compile time)
- Certain Chromium APIs are limited or missing

This project demonstrates how to work around these limitations using only what the browser provides.

## Architecture

```
                     ┌──────────────────────┐
                     │    Tesla Browser      │
                     │  (QtWebEngine)        │
                     │                       │
                     │  ┌─────────────────┐  │
                     │  │  JSMpeg (WebGL)  │  │
                     │  │  render → canvas │  │
                     │  └────────┬────────┘  │
                     │           │           │
                     │  ┌────────┴────────┐  │
                     │  │  <audio> MP3    │  │
                     │  └────────┬────────┘  │
                     └───────────┼───────────┘
                                 │ WSS / HTTP
                                 │
                    ┌────────────┴────────────┐
                    │    Node.js (Express)     │
                    │                         │
                    │  ┌───────────────────┐  │
                    │  │ yt-dlp → Twitch   │  │
                    │  │ ffmpeg → MPEG1-TS │──┼──→ WSS
                    │  │ ffmpeg → MP3 audio│──┼──→ HTTP
                    │  └───────────────────┘  │
                    └─────────────────────────┘
```

Pages:

| URL | Description |
|-----|-------------|
| `/probe/` | Browser capability diagnostic — tests APIs, codecs, WebGL, mic |
| `/twitch-client/` | Full Twitch client — JSMpeg 30fps, OAuth, audio sync |

## Requirements

- Node.js 18+
- ffmpeg (with libmp3lame and mpeg1video support)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (install via `pip install yt-dlp`)

## Installation

### 1. System dependencies

The server requires **ffmpeg** and **yt-dlp** on your system:

```bash
# Debian/Ubuntu
sudo apt install ffmpeg
pip install yt-dlp

# macOS
brew install ffmpeg yt-dlp

# Windows (scoop)
scoop install ffmpeg yt-dlp
# or download manually: https://ffmpeg.org / https://github.com/yt-dlp/yt-dlp
```

Verify both are available:
```bash
ffmpeg -version | head -1
yt-dlp --version
```

### 2. Node dependencies

```bash
git clone https://github.com/Dailroy/tesla-video-drive.git
cd tesla-video-drive
npm install
cp .env.example .env
```

Edit `.env` with your Twitch app credentials (see [Configuration](#configuration)).

### 3. Start

```bash
npm start
```

The server starts on `http://localhost:8742`.

### Docker (recommended for a server / NAS / VPS)

```bash
docker build -t tesla-video .
docker run -d --name tesla-video -p 80:80 -p 8742:8742 tesla-video
```

Then open `http://<server-ip>` — UI, API and streams all come from that one process.

### Exposing the app to the internet

The server must be reachable from outside your home network. Pick one:

1. **Pinggy tunnel (easiest, no account)** — double-click `expose.bat` (Windows) or run `node tunnel.js`:
   ```
   ПУБЛИЧНЫЙ АДРЕС: https://xxxx-<your-ip>.run.pinggy-free.link
   ```
   The address is a real domain (no port forwarding, works from any network); WebSocket works over `wss://` out of the box. Notes: the free tunnel shows a one-time "Enter site" page in browsers (tap it once — afterwards the cookie remembers you), lives 60 minutes per start (rerun `expose.bat` for a fresh URL), and YouTube still resolves from your home IP.
2. **VPS + reverse proxy with TLS** (nginx/Caddy) — one stable URL, WebSocket becomes `wss://`.
3. **Cloudflare Tunnel** (free, no port forwarding) — run `cloudflared` next to the app:
   ```bash
   cloudflared tunnel --url http://127.0.0.1:8742
   ```
4. **Tailscale / ZeroTier** — private VPN: the car and the server join the same tailnet and you open the tailnet URL directly. Best when you do not want the app public at all.

> YouTube blocks many data-center IPs. If `resolve` fails on a VPS, run the same container at home and reach it through a tunnel instead.

### GitHub Pages (UI only)

The UI can live on GitHub Pages while the backend runs anywhere:

1. Deploy the backend (Docker or a machine at home) and note its URL, e.g. `https://tv.example.com`.
2. Push the repository — the bundled workflow (`.github/workflows/pages.yml`) publishes `public/` to GitHub Pages. Enable it once: **Settings → Pages → Source: GitHub Actions**.
3. Open the page once with `?api=https://tv.example.com` — the address is stored in `localStorage`, so later visits need no parameter.

```
https://<user>.github.io/tesla-video-drive/?api=https://tv.example.com
```

Caveats: the backend must be **HTTPS** (Pages is served over HTTPS, so plain `http://`/`ws://` backends are blocked as mixed content — use a tunnel or a reverse proxy with TLS), and the Twitch OAuth redirect URI must be registered for the backend origin.

### Apache reverse proxy (optional)

If you want HTTPS (required for WebSocket on Tesla):

```
ProxyPass / http://127.0.0.1:8742/
RewriteCond %{HTTP:Upgrade} =websocket [NC]
RewriteCond %{HTTP:Connection} =upgrade [NC]
RewriteRule /(.*) ws://127.0.0.1:8742/$1 [P,L]
ProxyTimeout 300
```

## Configuration

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 8742) |
| `HOST` | Bind address (default: `0.0.0.0`) |
| `ALT_PORT` | Second port, useful for plain `http://<ip>/` in the car (default: 80) |
| `PUBLIC_URL` | Public origin of the app (e.g. `https://tv.example.com`); used for the Twitch OAuth redirect and for links shown in the UI |
| `TLS_CERT` | Path to a PEM certificate — enables built-in HTTPS on `PORT` (leave empty for plain HTTP) |
| `TLS_KEY` | Path to the matching PEM private key |
| `HWACCEL` | ffmpeg hardware decode for the encoder input: `auto` (default), `d3d11va`, `cuda`, `off` |
| `FFMPEG` | ffmpeg binary path (default: found on `PATH`) |
| `AUDIO_BITRATE` | Audio pipe bitrate (default: `96k`) |
| `TWITCH_CLIENT_ID` | Twitch app client ID |
| `TWITCH_CLIENT_SECRET` | Twitch app client secret |
| `TWITCH_REDIRECT_URI` | OAuth redirect URI (default: `http://localhost:8742/api/twitch/callback`) |
| `YT_DLP` | yt-dlp binary path (default: found on `PATH`) |

### Setting up Twitch OAuth

1. Go to [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps)
2. Click **Register Your Application**
3. Name: anything (e.g. "Tesla Browser")
4. OAuth Redirect URL: `http://YOUR_SERVER:8742/api/twitch/callback`
5. Category: **Application Integration**
6. Copy **Client ID** and **Client Secret** into `.env`

## API Endpoints

### Streams and control

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/resolve?src=URL&quality=720` | Resolve a YouTube/Twitch/Vimeo URL (or search query) → stream token + metadata |
| `GET` | `/api/search?q=text` | YouTube search results for the UI |
| `WS` | `/ws/mpeg1?token=T&ss=SEC&delay=MS` | MPEG1-TS video stream (primary transport) |
| `GET` | `/stream/mpeg1?token=T&ss=SEC&delay=MS` | Same stream over HTTP chunked transfer (fallback when WebSocket is blocked) |
| `GET` | `/api/live-audio?token=T&ss=SEC` | MP3 audio stream (native `<audio>`) |
| `GET` | `/api/stream-delay?token=T&value=MS` | Set video delay over HTTP (transport fallback) |
| `GET` | `/api/stream-status?token=T` | Pipe state: bytes, delay, encoder fps/speed, errors |
| `GET` | `/api/health` | Server status + LAN address for the car |

### Probe

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/probe-report` | Receive browser diagnostic data (JSON body) |

### Twitch

| Method | Endpoint | Description |
|--------|----------|-------------|
| `WS` | `/ws/mpeg1?channel=X&quality=720` | MPEG1-TS video stream via WebSocket |
| `GET` | `/api/live-audio?channel=X` | MP3 audio stream |
| `GET` | `/api/twitch/live?channel=X` | Check if channel is live |
| `GET` | `/api/twitch/status?channel=X` | Channel title and viewer count |
| `GET` | `/api/twitch/login` | OAuth login redirect |
| `GET` | `/api/twitch/callback` | OAuth callback |
| `GET` | `/api/twitch/follows?token=X` | Fetch followed channels |

### Quality presets

`?quality=360|480|720|1080` maps to ffmpeg scale `640:360|854:480|1280:720|1920:1080`.

## How it works

### Probe (`/probe/`)

A standalone diagnostic page that systematically tests the Tesla browser's capabilities:

- User-Agent, Chromium/WebKit version
- WebSocket, WebGL, Canvas 2D, createImageBitmap
- MediaSource Extensions, VideoDecoder (WebCodecs)
- WebAssembly, ServiceWorker, AudioContext
- H.264, H.265, VP8, VP9 codec support
- Microphone access (getUserMedia)
- Auto-submits a report to the server via `sendBeacon`

### Twitch Client (`/twitch-client/`)

Uses a two-pipe architecture to bypass the `<video>` restriction:

**Video**: `yt-dlp` resolves the Twitch stream URL → `ffmpeg` encodes to MPEG1-TS → WebSocket binary → **JSMpeg** (pure JS + WebGL decoder) → canvas at 30fps

**Audio**: Separate HTTP stream → `ffmpeg` encodes to low-bitrate MP3 → native `<audio>` element (Tesla doesn't block audio)

The video waits for audio to start playing before launching, then compensates for the audio endpoint's ~5s buffer delay by seeking forward.

### Why MPEG1?

MPEG1 with inter-frame compression (P-frames) is ~5x more efficient than sending full JPEG/WebP frames:

| Metric | JPEG frames | MPEG1 + JSMpeg |
|--------|:-----------:|:--------------:|
| FPS | 25 | **30** |
| Bandwidth | ~1.4 Mbps | **~0.8 Mbps** |
| Inter-frame compression | No | Yes |
| GPU acceleration | No | WebGL |

### Key bypass insight

The `<video>` element is hooked by Tesla's system — they call `video.pause()` at the OS level, and `drawImage(video, canvas)` produces a black frame when the source is paused. The solution: **never use `<video>`**. Send individual frames (or MPEG1 transport stream) over WebSocket, decode client-side, and render on a `<canvas>`.

## Probe results (Tesla Chromium)

| API | Status |
|-----|:------:|
| WebSocket | Available |
| Canvas 2D | Available |
| WebGL | Available |
| createImageBitmap | Available |
| MediaSource (MSE) | Limited codecs |
| WebCodecs | Not available |
| WebRTC | Not available |
| getUserMedia | Blocked (compile-time) |
| WebAssembly | Available |

## Known limitations

- **Microphone**: `getUserMedia` is blocked at the Chromium compilation level. Not bypassable from JavaScript.
- **A/V sync**: video is buffered server-side and started ~2.6 s after the audio; the delay is re-measured every second and re-sent, so drift stays under ~0.1 s. Audio still leads video slightly right after a seek/resume for 1–2 s.
- **YouTube from cloud IPs**: YouTube frequently returns 403 to data-center addresses. If resolve fails on a VPS, run the app at home and expose it through a tunnel.
- **Autoplay policy**: the browser may refuse audio until the first tap — the UI shows a hint, and any tap starts playback.
- **No native controls**: Volume, playback, and sync must be controlled via the custom UI. If FPS drops below ~18 for a few seconds the player lowers the quality automatically.
- **ffmpeg dependency**: The server requires ffmpeg with mpeg1video and libmp3lame support, plus yt-dlp.

## License

MIT
