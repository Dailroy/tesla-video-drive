const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawn, spawnSync } = require('child_process');

// minimal .env loader (no dependency) - must run before reading process.env
(function loadEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    raw.split(/\r?\n/).forEach(function (line) {
      const s = line.trim();
      if (!s || s.charAt(0) === '#') return;
      const eq = s.indexOf('=');
      if (eq < 1) return;
      const k = s.slice(0, eq).trim();
      let v = s.slice(eq + 1).trim();
      if ((v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') ||
          (v.charAt(0) === "'" && v.charAt(v.length - 1) === "'")) {
        v = v.slice(1, -1);
      }
      if (!(k in process.env)) process.env[k] = v;
    });
  } catch (e) {}
})();

const PORT = parseInt(process.env.PORT, 10) || 8742;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const QUALITY_HEIGHT = { 360: 360, 480: 480, 720: 720, 1080: 1080 };
const QUALITY_SCALE = { 360: '640:360', 480: '854:480', 720: '1280:720', 1080: '1920:1080' };
const QUALITY_BITRATE = { 360: '600k', 480: '900k', 720: '1500k', 1080: '3000k' };
const AUDIO_BITRATE = process.env.AUDIO_BITRATE || '96k';
const DEFAULT_DELAY = 4500;
const MAX_QUEUE_BYTES = 128 * 1024 * 1024;

// ============================================================
// Tool discovery (PATH first, then common Windows install dirs)
// ============================================================
function probe(bin, args) {
  try {
    const r = spawnSync(bin, args, { windowsHide: true, timeout: 10000 });
    return !r.error && (r.status === 0 || r.status === 1);
  } catch (e) {
    return false;
  }
}

function walkFor(base, depth, fileName) {
  if (depth < 0) return null;
  let items;
  try {
    items = fs.readdirSync(base, { withFileTypes: true });
  } catch (e) {
    return null;
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const full = path.join(base, it.name);
    if (it.isFile() && it.name.toLowerCase() === fileName) return full;
    if (it.isDirectory()) {
      const hit = walkFor(full, depth - 1, fileName);
      if (hit) return hit;
    }
  }
  return null;
}

function findTool(name, envValue, probeArgs, extraCandidates) {
  if (envValue && fs.existsSync(envValue)) return envValue;
  if (probe(name, probeArgs)) return name;
  const roots = (extraCandidates || []).filter(Boolean);
  for (let i = 0; i < roots.length; i++) {
    const hit = walkFor(roots[i], 4, name + '.exe');
    if (hit) return hit;
  }
  return null;
}

const winRoots = process.platform === 'win32' ? {
  winget: path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages'),
  pyLocal: path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python'),
  pyRoaming: path.join(process.env.APPDATA || '', 'Python'),
} : {};

const FFMPEG = findTool(
  'ffmpeg',
  process.env.FFMPEG,
  ['-version'],
  [winRoots.winget]
);
const YT_DLP = findTool(
  'yt-dlp',
  process.env.YT_DLP,
  ['--version'],
  [
    winRoots.pyLocal ? path.join(winRoots.pyLocal, 'Scripts') : null,
    winRoots.pyRoaming ? path.join(winRoots.pyRoaming, 'Python312', 'Scripts') : null,
    winRoots.pyRoaming ? path.join(winRoots.pyRoaming, 'Python311', 'Scripts') : null,
    winRoots.pyRoaming ? path.join(winRoots.pyRoaming, 'Python313', 'Scripts') : null,
  ]
);

if (!FFMPEG) console.warn('[warn] ffmpeg not found - video/audio streams will not start');
if (!YT_DLP) console.warn('[warn] yt-dlp not found - YouTube/Twitch resolve will fail');
console.log('ffmpeg : ' + (FFMPEG || 'MISSING'));
console.log('yt-dlp : ' + (YT_DLP || 'MISSING'));

function toolError(name, present) {
  return new Error(name + (present ? '' : ' not found') + ' - install ' + name + ' or set ' + name.toUpperCase().replace('-', '_') + ' in .env');
}

// ============================================================
// yt-dlp helpers
// ============================================================
function ytdlp(args, cb) {
  if (!YT_DLP) return cb(toolError('yt-dlp', false));
  execFile(YT_DLP, args, {
    timeout: 60000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    killSignal: 'SIGKILL',
  }, (err, stdout, stderr) => {
    if (err) {
      const msg = String(stderr || err.message || '').split('\n').filter(function (l) {
        return l && l.indexOf('WARNING') !== 0;
      }).join(' ').trim();
      return cb(new Error(msg.slice(0, 300) || 'yt-dlp failed'));
    }
    cb(null, stdout);
  });
}

function safeSrc(raw) {
  const src = String(raw || '').trim();
  if (!src) return null;
  if (src.charAt(0) === '-') return null;
  if (src.length > 500) return null;
  return src;
}

function formatArgs(quality) {
  const h = QUALITY_HEIGHT[quality] || 720;
  return 'bv*[height<=' + h + '][vcodec^=avc1]+ba'
    + '/bv*[height<=' + h + ']+ba'
    + '/b[height<=' + h + ']'
    + '/b'
    + '/best';
}

function pickFormats(info) {
  const list = (info.requested_formats && info.requested_formats.length)
    ? info.requested_formats
    : [info];
  let video = null;
  let audio = null;
  let both = null;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (!f || !f.url) continue;
    const hasV = !!f.vcodec && f.vcodec !== 'none';
    const hasA = !!f.acodec && f.acodec !== 'none';
    if (hasV && hasA) both = f;
    else if (hasV && !video) video = f;
    else if (hasA && !audio) audio = f;
  }
  function out(v, a) {
    return {
      videoUrl: v.url, audioUrl: a.url,
      videoHeaders: v.http_headers || null,
      audioHeaders: a.http_headers || null,
    };
  }
  if (both && !video && !audio) return out(both, both);
  if (video && audio) return out(video, audio);
  if (both && video && !audio) return out(video, both);
  if (both && audio && !video) return out(both, audio);
  return null;
}

const resolveCache = new Map();

// ffmpeg needs the same headers yt-dlp used, otherwise YouTube answers 403
function httpHeaderArgs(h) {
  if (!h) return [];
  const lines = [];
  Object.keys(h).forEach(function (k) {
    if (/^(user-agent|referer|origin|cookie|accept-language)$/i.test(k)) {
      lines.push(k + ': ' + String(h[k]).replace(/[\r\n]+/g, ' '));
    }
  });
  if (!lines.length) return [];
  return ['-headers', lines.join('\r\n') + '\r\n'];
}

function resolveStream(src, quality, cb) {
  const key = src + '|' + quality;
  const hit = resolveCache.get(key);
  if (hit && Date.now() - hit.at < 4 * 60 * 1000) return cb(null, hit.data);

  const args = ['--no-warnings', '-J', '-f', formatArgs(quality)];
  if (/^https?:\/\//i.test(src) && !/[?&]list=/.test(src)) args.push('--no-playlist');
  args.push(src);

  ytdlp(args, function (err, stdout) {
    if (err) return cb(err);
    let info;
    try {
      info = JSON.parse(stdout);
    } catch (e) {
      return cb(new Error('yt-dlp returned bad JSON'));
    }
    if (info && info.entries && info.entries.length) info = info.entries[0];
    if (!info) return cb(new Error('Nothing found'));
    const urls = pickFormats(info);
    if (!urls) return cb(new Error('No playable video/audio format'));

    const data = {
      src: src,
      quality: quality,
      videoUrl: urls.videoUrl,
      audioUrl: urls.audioUrl,
      videoHeaders: urls.videoHeaders || null,
      audioHeaders: urls.audioHeaders || null,
      title: info.title || src,
      isLive: !!info.is_live,
      duration: info.duration || 0,
      thumbnail: info.thumbnail || '',
      webpageUrl: info.webpage_url || src,
      uploader: info.uploader || info.channel || '',
    };
    resolveCache.set(key, { at: Date.now(), data: data });
    if (resolveCache.size > 60) {
      const firstKey = resolveCache.keys().next().value;
      resolveCache.delete(firstKey);
    }
    cb(null, data);
  });
}

// short-lived tokens so the client resolves once and starts both pipes
const tokens = new Map();

function makeToken(data) {
  const token = crypto.randomBytes(9).toString('hex');
  tokens.set(token, { data: data, at: Date.now() });
  if (tokens.size > 120) {
    const now = Date.now();
    tokens.forEach(function (v, k) { if (now - v.at > 20 * 60 * 1000) tokens.delete(k); });
  }
  return token;
}

function payloadFromQuery(query, cb) {
  if (query.token && tokens.has(query.token)) {
    const entry = tokens.get(query.token);
    entry.at = Date.now();
    return cb(null, entry.data);
  }
  let src = safeSrc(query.src || query.url);
  const channel = String(query.channel || '').replace(/[^a-zA-Z0-9_]/g, '');
  if (!src && channel) src = 'https://www.twitch.tv/' + channel;
  if (!src) return cb(new Error('Missing ?token= or ?src='));
  const quality = QUALITY_HEIGHT[parseInt(query.quality, 10)] || 720;
  resolveStream(src, quality, cb);
}

function num(v, def) {
  const n = parseFloat(v);
  return isNaN(n) ? def : n;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ============================================================
// App
// ============================================================
const app = express();

// allow the UI to be hosted elsewhere (GitHub Pages) and call this backend
app.use(function (req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(PUBLIC_DIR));

function lanIps() {
  const out = [];
  const nets = require('os').networkInterfaces();
  Object.keys(nets).forEach(function (name) {
    nets[name].forEach(function (n) {
      if (n.family === 'IPv4' && !n.internal && !/^169\.254\./.test(n.address)) out.push(n.address);
    });
  });
  function rank(ip) {
    if (/^192\.168\./.test(ip)) return 3;
    if (/^10\./.test(ip)) return 2;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 1; // VPN / public-looking
  }
  return out.sort(function (a, b) { return rank(b) - rank(a); });
}

// public address as seen by the client (works behind a tunnel / reverse proxy)
function requestOrigin(req) {
  const envUrl = (process.env.PUBLIC_URL || '').trim();
  if (envUrl) return envUrl.replace(/\/+$/, '');
  const protoHdr = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = protoHdr || (req.secure ? 'https' : 'http');
  const hostHdr = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const host = hostHdr || (HOST + ':' + PORT);
  return proto + '://' + host;
}

function isLocalRequest(req) {
  const ip = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  return false;
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    ffmpeg: !!FFMPEG,
    ytDlp: !!YT_DLP,
    host: HOST,
    port: PORT,
    lan: lanIps(),
    origin: requestOrigin(req),
    local: isLocalRequest(req),
  });
});

app.post('/api/probe-report', express.json({ limit: '1mb' }), (req, res) => {
  const data = req.body || {};
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportsDir = path.join(__dirname, '..', 'probe-reports');
  const filename = path.join(reportsDir, 'probe-' + timestamp + '.json');
  try {
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    console.log('Probe report saved: ' + filename);
    res.json({ ok: true, file: filename });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ============================================================
// Resolve: URL / Twitch channel / YouTube search -> token
// ============================================================
app.get('/api/resolve', (req, res) => {
  const src = safeSrc(req.query.src);
  if (!src) return res.status(400).json({ ok: false, error: 'Missing ?src=' });
  const quality = QUALITY_HEIGHT[parseInt(req.query.quality, 10)] || 720;
  resolveStream(src, quality, function (err, data) {
    if (err) return res.status(502).json({ ok: false, error: err.message });
    res.json({
      ok: true,
      token: makeToken(data),
      title: data.title,
      isLive: data.isLive,
      duration: data.duration,
      thumbnail: data.thumbnail,
      uploader: data.uploader,
      webpageUrl: data.webpageUrl,
      quality: quality,
    });
  });
});

// ============================================================
// YouTube search
// ============================================================
app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ ok: false, error: 'Missing ?q=' });
  const args = ['--no-warnings', '--flat-playlist', '-J', 'ytsearch12:' + q.slice(0, 120)];
  ytdlp(args, function (err, stdout) {
    if (err) return res.status(502).json({ ok: false, error: err.message });
    let info;
    try {
      info = JSON.parse(stdout);
    } catch (e) {
      return res.status(502).json({ ok: false, error: 'Bad response' });
    }
    const out = [];
    const entries = (info && info.entries) || [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const id = String(e.id || '');
      if (!/^[\w-]{11}$/.test(id)) continue;
      out.push({
        id: id,
        url: 'https://www.youtube.com/watch?v=' + id,
        title: e.title || id,
        duration: e.duration || 0,
        uploader: e.uploader || e.channel || '',
      });
    }
    res.json({ ok: true, results: out });
  });
});

// ============================================================
// Twitch helpers (kept for /twitch-client/)
// ============================================================
app.get('/api/twitch/live', (req, res) => {
  const ch = String(req.query.channel || '').replace(/[^a-zA-Z0-9_]/g, '');
  if (!ch) return res.json({ live: false, error: 'Missing channel' });
  if (!YT_DLP) return res.json({ channel: ch, live: false, error: 'yt-dlp missing' });
  ytdlp(['--no-warnings', '--no-playlist', '-g', '-f', 'best', 'https://www.twitch.tv/' + ch], function (err, stdout) {
    const live = !err && !!stdout && stdout.trim().length > 0;
    res.json({ channel: ch, live: live });
  });
});

app.get('/api/twitch/status', (req, res) => {
  const channel = String(req.query.channel || '').replace(/[^a-zA-Z0-9_]/g, '');
  if (!channel) return res.json({ error: 'Missing channel' });
  if (!YT_DLP) return res.json({ live: false, channel: channel, error: 'yt-dlp missing' });
  ytdlp([
    '--no-warnings', '--no-playlist',
    '--print', '%(title)s|%(view_count)s',
    'https://www.twitch.tv/' + channel,
  ], function (err, stdout) {
    if (err) {
      const m = /not currently live|offline/i.test(err.message);
      return res.json({ live: false, channel: channel, error: m ? 'offline' : err.message.slice(0, 80) });
    }
    const parts = String(stdout).trim().split('|');
    res.json({ live: true, channel: channel, title: parts[0] || 'Live', viewers: parseInt(parts[1], 10) || 0 });
  });
});

// ============================================================
// Audio stream (MP3) - separate pipe, played through <audio>
// ============================================================
function audioArgs(payload, ss) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (ss > 0) args.push('-ss', String(ss));
  args.push('-re');
  if (/^https?:\/\//i.test(payload.audioUrl)) {
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10');
    if (payload.isLive) args.push('-reconnect_at_eof', '1');
  }
  args.push.apply(args, httpHeaderArgs(payload.audioHeaders));
  args.push(
    '-probesize', '2000000', '-analyzeduration', '1000000',
    '-i', payload.audioUrl,
    '-vn',
    '-c:a', 'libmp3lame', '-b:a', AUDIO_BITRATE,
    '-ar', '44100', '-ac', '2',
    '-f', 'mp3', '-'
  );
  return args;
}

function streamAudio(payload, ss, res) {
  if (!FFMPEG) {
    res.status(500).type('text/plain').send('ffmpeg not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Connection': 'close',
    'Access-Control-Allow-Origin': '*',
  });
  let ffmpeg;
  try {
    ffmpeg = spawn(FFMPEG, audioArgs(payload, ss), { windowsHide: true });
  } catch (e) {
    res.end();
    return;
  }
  ffmpeg.stdout.pipe(res);
  ffmpeg.stderr.on('data', function () {});
  ffmpeg.on('error', function () { try { res.end(); } catch (e) {} });
  ffmpeg.on('close', function () { try { res.end(); } catch (e) {} });
  res.on('close', function () { try { ffmpeg.kill(); } catch (e) {} });
}

app.get('/api/live-audio', (req, res) => {
  const ss = Math.max(0, num(req.query.ss, 0));
  payloadFromQuery(req.query, function (err, payload) {
    if (err) return res.status(502).type('text/plain').send(err.message);
    streamAudio(payload, ss, res);
  });
});

// ============================================================
// Twitch OAuth (kept)
// ============================================================
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';

// redirect follows whatever address the user opened (LAN, tunnel, domain)
function twitchRedirectUri(req) {
  if (process.env.TWITCH_REDIRECT_URI) return TWITCH_REDIRECT_URI;
  return requestOrigin(req) + '/api/twitch/callback';
}

app.get('/api/twitch/login', (req, res) => {
  const redirectUri = twitchRedirectUri(req);
  if (!TWITCH_CLIENT_ID) {
    return res.send('<html><body style="background:#0a0a0f;color:#e0e0e0;font-family:sans-serif;padding:20px;">'
      + '<h1 style="color:#9146ff;">Twitch Login</h1>'
      + '<p>Set <b>TWITCH_CLIENT_ID</b> and <b>TWITCH_CLIENT_SECRET</b> in your .env file.</p>'
      + '<ol><li>Go to <a href="https://dev.twitch.tv/console/apps" style="color:#9146ff;">dev.twitch.tv</a></li>'
      + '<li>Register an Application (redirect URI: <b>' + redirectUri + '</b>)</li>'
      + '<li>Copy Client ID and Client Secret into .env</li></ol>'
      + '<p style="color:#888;">No payment info required - it is free.</p></body></html>');
  }
  res.redirect('https://id.twitch.tv/oauth2/authorize'
    + '?client_id=' + TWITCH_CLIENT_ID
    + '&redirect_uri=' + encodeURIComponent(redirectUri)
    + '&response_type=code'
    + '&scope=user:read:follows');
});

app.get('/api/twitch/callback', (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code');
  const https = require('https');
  const data = 'client_id=' + TWITCH_CLIENT_ID
    + '&client_secret=' + TWITCH_CLIENT_SECRET
    + '&code=' + encodeURIComponent(code)
    + '&grant_type=authorization_code'
    + '&redirect_uri=' + encodeURIComponent(twitchRedirectUri(req));
  const req2 = https.request({
    hostname: 'id.twitch.tv',
    method: 'POST',
    path: '/oauth2/token',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }, function (res2) {
    let body = '';
    res2.on('data', function (chunk) { body += chunk; });
    res2.on('end', function () {
      try {
        const token = JSON.parse(body);
        if (token.access_token) res.redirect('/?token=' + token.access_token + '&login=success');
        else res.send('OAuth error: ' + JSON.stringify(token));
      } catch (e) {
        res.send('Parse error: ' + body);
      }
    });
  });
  req2.write(data);
  req2.end();
});

app.get('/api/twitch/follows', (req, res) => {
  const token = req.query.token;
  if (!token) return res.json({ error: 'Missing token' });
  const https = require('https');
  https.get({
    hostname: 'api.twitch.tv',
    path: '/helix/users',
    headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': 'Bearer ' + token },
  }, function (res2) {
    let body = '';
    res2.on('data', function (c) { body += c; });
    res2.on('end', function () {
      let user;
      try { user = JSON.parse(body); } catch (e) { return res.json({ error: 'Parse error' }); }
      if (!user.data || !user.data[0]) return res.json({ error: 'No user' });
      const userId = user.data[0].id;
      https.get({
        hostname: 'api.twitch.tv',
        path: '/helix/channels/followed?user_id=' + userId + '&first=100',
        headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': 'Bearer ' + token },
      }, function (res3) {
        let body2 = '';
        res3.on('data', function (c) { body2 += c; });
        res3.on('end', function () {
          try {
            const follows = JSON.parse(body2);
            const channels = (follows.data || []).map(function (f) {
              return f.broadcaster_name ? f.broadcaster_name.toLowerCase() : null;
            }).filter(Boolean);
            res.json({ ok: true, channels: channels, total: follows.total || channels.length });
          } catch (e) {
            res.json({ error: 'Parse error' });
          }
        });
      });
    });
  });
});

// ============================================================
// WebSocket: MPEG1 video
// ============================================================
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

function sendJson(ws, obj) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }
}

function videoArgs(payload, ss, scale, bitrate) {
  const args = ['-hide_banner', '-loglevel', 'error', '-stats'];
  if (ss > 0) args.push('-ss', String(ss));
  const hw = (process.env.HWACCEL || 'auto').toLowerCase();
  if (hw && hw !== 'off' && hw !== '0') args.push('-hwaccel', hw);
  args.push('-re');
  if (/^https?:\/\//i.test(payload.videoUrl)) {
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10');
    if (payload.isLive) args.push('-reconnect_at_eof', '1');
  }
  args.push.apply(args, httpHeaderArgs(payload.videoHeaders));
  args.push(
    '-probesize', '4000000', '-analyzeduration', '2000000',
    '-i', payload.videoUrl,
    '-an',
    '-vf', 'fps=30,scale=' + scale + ':flags=fast_bilinear:force_original_aspect_ratio=decrease,pad=' + scale + ':-1:-1',
    '-c:v', 'mpeg1video', '-pix_fmt', 'yuv420p',
    '-q:v', '5', '-b:v', bitrate, '-bf', '0',
    '-f', 'mpegts', '-muxdelay', '0.1', '-muxpreload', '0',
    '-'
  );
  return args;
}

// ---- per-token pipe state: lets HTTP-mode clients push delay + read errors ----
const pipeStates = new Map();

function findPipeState(token) {
  return token ? (pipeStates.get(token) || null) : null;
}

function pipeState(token) {
  if (!token) return null;
  let st = pipeStates.get(token);
  if (!st) {
    st = { delay: { value: DEFAULT_DELAY }, error: '', bytes: 0, started: 0, ended: 0, encodeFps: 0, speed: 0 };
    pipeStates.set(token, st);
  }
  if (pipeStates.size > 80) {
    const now = Date.now();
    pipeStates.forEach(function (v, k) { if (v.started && now - v.started > 10 * 60 * 1000) pipeStates.delete(k); });
  }
  return st;
}

function wsSink(ws) {
  return {
    kind: 'ws',
    send: function (buf) {
      if (ws.readyState === 1) { try { ws.send(buf, { binary: true }); } catch (e) {} }
    },
    sendJson: function (obj) { sendJson(ws, obj); },
    close: function () { try { ws.close(); } catch (e) {} },
    isClosed: function () { return ws.readyState !== 1; },
    onControl: function (cb) {
      ws.on('message', function (raw) {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        cb(msg);
      });
    },
    onClose: function (cb) { ws.on('close', cb); ws.on('error', cb); },
  };
}

function httpSink(res, token) {
  return {
    kind: 'http',
    token: token,
    send: function (buf) {
      if (!res.writableEnded) { try { res.write(buf); } catch (e) {} }
    },
    sendJson: function () {},
    close: function () { try { res.end(); } catch (e) {} },
    isClosed: function () { return res.writableEnded || res.destroyed; },
    onControl: function () {},
    onClose: function (cb) { res.on('close', cb); },
  };
}

function startPipe(sink, payload, query) {
  const ss = Math.max(0, num(query.ss, 0));
  const quality = QUALITY_HEIGHT[payload.quality] || 720;
  const scale = QUALITY_SCALE[quality] || '1280:720';
  const bitrate = QUALITY_BITRATE[quality] || '1500k';
  const st = pipeState(String(query.token || ''));
  const holder = st ? st.delay : { value: clamp(num(query.delay, DEFAULT_DELAY), 0, 30000) };
  if (st) {
    holder.value = clamp(num(query.delay, holder.value), 0, 30000);
    st.error = ''; st.bytes = 0; st.started = Date.now(); st.ended = 0;
  }

  if (!FFMPEG) {
    sink.sendJson({ type: 'error', message: 'ffmpeg not found on the server' });
    sink.close();
    return;
  }

  sink.sendJson({ type: 'status', message: 'Starting video...', title: payload.title });

  let ffmpeg;
  try {
    ffmpeg = spawn(FFMPEG, videoArgs(payload, ss, scale, bitrate), { windowsHide: true });
  } catch (e) {
    if (st) st.error = e.message.slice(0, 200);
    sink.sendJson({ type: 'error', message: e.message.slice(0, 200) });
    sink.close();
    return;
  }

  let stderr = '';
  let bytes = 0;
  const queue = [];
  let closed = false;
  let lastEncSent = 0;

  if (st) { st.encodeFps = 0; st.speed = 0; }

  ffmpeg.stderr.on('data', function (d) {
    const text = d.toString();
    stderr = (stderr + text).slice(-800);
    // ffmpeg -stats lines: "frame= 168 fps= 33 q=5.0 ... speed=1.08x"
    const mFps = /fps=\s*([\d.]+)/.exec(text);
    const mSpeed = /speed=\s*([\d.]+)x/.exec(text);
    if (st && (mFps || mSpeed)) {
      if (mFps) st.encodeFps = parseFloat(mFps[1]);
      if (mSpeed) st.speed = parseFloat(mSpeed[1]);
      const now = Date.now();
      if (now - lastEncSent > 5000) {
        lastEncSent = now;
        sink.sendJson({ type: 'enc', fps: st.encodeFps, speed: st.speed });
      }
    }
  });

  ffmpeg.stdout.on('data', function (chunk) {
    bytes += chunk.length;
    if (st) st.bytes = bytes;
    if (bytes > MAX_QUEUE_BYTES) {
      if (st) st.error = 'Stream buffer overflow';
      sink.sendJson({ type: 'error', message: 'Stream buffer overflow' });
      stop();
      return;
    }
    queue.push({ t: Date.now(), b: chunk });
    flush();
  });

  function flush() {
    const cutoff = Date.now() - holder.value;
    while (queue.length && queue[0].t <= cutoff) {
      if (sink.isClosed()) return;
      sink.send(queue.shift().b);
    }
  }

  // 40ms tick = smooth frame pacing (100ms made playback visibly bursty)
  const timer = setInterval(flush, 40);

  function stop() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    queue.length = 0;
    if (st) st.ended = Date.now();
    try { ffmpeg.kill(); } catch (e) {}
  }

  ffmpeg.on('error', function (e) {
    if (st) st.error = 'ffmpeg: ' + e.message.slice(0, 150);
    sink.sendJson({ type: 'error', message: 'ffmpeg: ' + e.message.slice(0, 150) });
    stop();
  });

  ffmpeg.on('close', function (code) {
    if (!closed) {
      if (code && st && !st.error) st.error = stderr.slice(-300);
      sink.sendJson({
        type: 'status',
        message: 'Stream ended' + (code ? ' (code ' + code + ')' : ''),
        stderr: code ? stderr.slice(-300) : '',
      });
    }
    closed = true;
    clearInterval(timer);
    queue.length = 0;
    if (st) st.ended = Date.now();
    sink.close();
  });

  sink.onControl(function (msg) {
    if (msg.type === 'delay') {
      holder.value = clamp(num(msg.value, holder.value), 0, 30000);
      flush();
      sink.sendJson({ type: 'delay', value: holder.value });
    } else if (msg.type === 'ping') {
      sink.sendJson({ type: 'pong', value: Date.now() });
    }
  });

  sink.onClose(stop);
}

// ---- HTTP transport (fallback when WebSocket is blocked by the browser) ----
app.get('/stream/mpeg1', (req, res) => {
  const q = req.query;
  payloadFromQuery(q, function (err, payload) {
    if (err) {
      const st = pipeState(String(q.token || ''));
      if (st) { st.error = err.message.slice(0, 200); st.started = st.started || Date.now(); }
      return res.status(502).type('text/plain').send(err.message);
    }
    if (!FFMPEG) {
      const st2 = pipeState(String(q.token || ''));
      if (st2) { st2.error = 'ffmpeg not found'; st2.started = st2.started || Date.now(); }
      return res.status(500).type('text/plain').send('ffmpeg not found');
    }
    res.writeHead(200, {
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'close',
      'Access-Control-Allow-Origin': '*',
    });
    startPipe(httpSink(res, String(q.token || '')), payload, q);
  });
});

app.get('/api/stream-delay', (req, res) => {
  const st = findPipeState(String(req.query.token || ''));
  if (!st) return res.json({ ok: false, error: 'unknown token' });
  st.delay.value = clamp(num(req.query.value, st.delay.value), 0, 30000);
  res.json({ ok: true, delay: st.delay.value });
});

app.get('/api/stream-status', (req, res) => {
  const st = findPipeState(String(req.query.token || ''));
  if (!st) return res.json({ ok: false, error: '', known: false });
  res.json({
    ok: !st.error,
    known: true,
    error: st.error,
    bytes: st.bytes,
    delay: st.delay.value,
    encodeFps: st.encodeFps || 0,
    speed: st.speed || 0,
    started: st.started,
    ended: st.ended,
  });
});

// optional HTTPS: set TLS_CERT / TLS_KEY (PEM files) to serve the app over TLS
// without an external reverse proxy (needed when the page is opened from the internet)
const TLS_CERT = (process.env.TLS_CERT || '').trim();
const TLS_KEY = (process.env.TLS_KEY || '').trim();
const usingTls = !!(TLS_CERT && TLS_KEY && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY));

function onListening() {
  const scheme = usingTls ? 'https' : 'http';
  console.log('Tesla video server: ' + scheme + '://' + HOST + ':' + PORT);
  console.log('Static files: ' + PUBLIC_DIR);
  if (process.env.PUBLIC_URL) console.log('Public URL:   ' + process.env.PUBLIC_URL);
  lanIps().forEach(function (ip) {
    console.log('Open in Tesla:  ' + scheme + '://' + ip + (PORT === 80 ? '' : ':' + PORT));
  });
}

const server = usingTls
  ? require('https').createServer({
      cert: fs.readFileSync(TLS_CERT),
      key: fs.readFileSync(TLS_KEY),
    }, app).listen(PORT, HOST, onListening)
  : app.listen(PORT, HOST, onListening);

function handleUpgrade(req, socket, head) {
  const url = require('url').parse(req.url, true);
  if (url.pathname === '/ws/mpeg1') {
    wss.handleUpgrade(req, socket, head, function (ws) {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
}

server.on('upgrade', handleUpgrade);

// extra listener on port 80 so the car can open http://<lan-ip> without a port
const ALT_PORT = parseInt(process.env.ALT_PORT, 10) || 80;
if (ALT_PORT && ALT_PORT !== PORT) {
  try {
    const alt = app.listen(ALT_PORT, HOST, function () {
      lanIps().forEach(function (ip) {
        console.log('Also:          http://' + ip + (ALT_PORT === 80 ? '' : ':' + ALT_PORT));
      });
    });
    alt.on('upgrade', handleUpgrade);
    alt.on('error', function (e) {
      if (e.code === 'EACCES') {
        console.log('Порт ' + ALT_PORT + ' недоступен: запусти сервер от имени администратора,'
          + ' чтобы открывать http://<ip> без порта (иначе используй :' + PORT + ')');
      } else {
        console.log('Alt port ' + ALT_PORT + ': ' + e.message);
      }
    });
  } catch (e) {}
}

wss.on('connection', function (ws, req) {
  const url = require('url').parse(req.url, true);
  payloadFromQuery(url.query, function (err, payload) {
    if (err) {
      sendJson(ws, { type: 'error', message: err.message.slice(0, 200) });
      ws.close();
      return;
    }
    startPipe(wsSink(ws), payload, url.query);
  });
});
