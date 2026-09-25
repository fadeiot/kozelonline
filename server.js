// ===== Боярський козел: онлайн-сервер =====
// Роздає сторінку гри та тримає столи для гри з друзями через WebSocket.
// Змінні середовища (Render → Environment):
//   BOT_TOKEN     — токен бота від @BotFather (перевірка гравців, аватарки, сповіщення)
//   BOT_USERNAME  — логін бота без @ (якщо не задано, береться з Telegram)
//   APP_NAME      — коротка назва Mini App з /newapp, напр. play
//   ALLOW_GUESTS  — 1, щоб дозволити гру з браузера без Telegram (для перевірки)
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN — сховище, щоб столи й статистика переживали перезапуск
//   PUBLIC_URL    — адреса сервера (на Render задається сама як RENDER_EXTERNAL_URL)
//   KEEP_AWAKE    — 0, щоб вимкнути самопінг (за замовчуванням увімкнено на Render)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const E = require('./engine.js');
const AI = require('./ai.js');
const Stats = require('./stats.js');
const Store = require('./store.js');
const Bots = require('./botpool.js');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
let BOT_USERNAME = (process.env.BOT_USERNAME || '').replace(/^@/, '');
const APP_NAME = process.env.APP_NAME || '';
const ALLOW_GUESTS = !BOT_TOKEN || process.env.ALLOW_GUESTS === '1';
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const KEEP_AWAKE = process.env.KEEP_AWAKE ? process.env.KEEP_AWAKE !== '0' : !!process.env.RENDER_EXTERNAL_URL;
const NOTIFY = process.env.NOTIFY === '1'; // увімкнути нагадування бота знову: NOTIFY=1
const WEBHOOK_SECRET = crypto.createHash('sha256').update('kozel-hook:' + BOT_TOKEN).digest('hex').slice(0, 32);

// Час на повернення: до 45 с — нічого не зупиняємо; до 3 хв — пауза; далі за гравця грає бот, доки не повернеться
const GRACE_MS = +process.env.GRACE_MS || 45 * 1000;   // (змінні середовища — лише для перевірок)
const AUTO_MS = +process.env.AUTO_MS || 3 * 60 * 1000;
const TURN_MS = 60000;           // на хід — 1 хвилина, далі за гравця ходить бот
const EMPTY_TTL = 30 * 60 * 1000; // стіл без жодної людини живе 30 хв
const rng = E.mulberry32((Date.now() ^ (Math.random() * 1e9)) >>> 0);

// ---------- Telegram Bot API ----------
async function tg(method, body) {
  if (!BOT_TOKEN) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    const j = await r.json();
    if (!j.ok) { console.log(`tg ${method}: ${j.description}`); return null; }
    return j.result;
  } catch (e) { console.log(`tg ${method}: ${e.message}`); return null; }
}
const appLink = code => BOT_USERNAME && APP_NAME ? `https://t.me/${BOT_USERNAME}/${APP_NAME}` + (code ? `?startapp=${code}` : '') : null;
if (BOT_TOKEN) {
  tg('getMe').then(me => {
    if (!me) return;
    if (BOT_USERNAME && BOT_USERNAME.toLowerCase() !== me.username.toLowerCase())
      console.log(`BOT_USERNAME у налаштуваннях (${BOT_USERNAME}) не збігається з ботом (${me.username}), використовую ${me.username}`);
    BOT_USERNAME = me.username;
    console.log('Бот: @' + BOT_USERNAME);
  });
}
// Сповіщення в особисті повідомлення бота (не частіше разу на хвилину для кожного гравця)
const lastNotify = new Map();
function notify(uid, text, code, force) {
  if (!NOTIFY) return; // нагадування в Telegram вимкнено на прохання гравців
  if (!BOT_TOKEN || !uid || !uid.startsWith('tg')) return;
  const now = Date.now();
  if (!force && now - (lastNotify.get(uid) || 0) < 60000) return;
  lastNotify.set(uid, now);
  const link = appLink(code);
  tg('sendMessage', {
    chat_id: uid.slice(2), text,
    reply_markup: link ? { inline_keyboard: [[{ text: code ? `Повернутися за стіл ${code}` : 'Грати', url: link }]] } : undefined,
  });
}

// ---------- Сторінка гри та файли ----------
const findFile = name => [path.join(__dirname, 'public', name), path.join(__dirname, name)].find(f => fs.existsSync(f));
function serveIndex(res) {
  const file = findFile('index.html');
  if (!file) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Не знайдено index.html. Завантажте його в репозиторій поруч із server.js.');
    return;
  }
  fs.readFile(file, 'utf8', (err, html) => {
    if (err) { res.writeHead(500); res.end('index.html read error'); return; }
    const cfg = `<script>window.KOZEL_ONLINE=${JSON.stringify({ bot: BOT_USERNAME, app: APP_NAME, guests: ALLOW_GUESTS, share: !!BOT_TOKEN })};</script>`;
    html = html.replace('<script', cfg + '\n<script');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(html);
  });
}
// Правила, боти й статистика — ті самі файли, що використовує сервер (одне джерело правил)
const SCRIPTS = { '/engine.js': 'engine.js', '/ai.js': 'ai.js', '/stats.js': 'stats.js' };
function serveScript(res, name) {
  const file = findFile(name);
  if (!file) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}
// Фонова музика. iPhone вимагає підтримки Range-запитів.
function serveMusic(req, res) {
  const file = findFile('music.m4a');
  if (!file) { res.writeHead(404); res.end(); return; }
  const size = fs.statSync(file).size;
  const head = { 'Content-Type': 'audio/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=604800' };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    let start = m[1] ? +m[1] : size - +m[2], end = m[1] && m[2] ? +m[2] : size - 1;
    if (!m[1]) end = size - 1;
    if (isNaN(start) || start < 0 || start >= size || end >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return;
    }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...head, 'Content-Length': size });
    fs.createReadStream(file).pipe(res);
  }
}
// Картинки результатів «Поділитися» (живуть 24 год у пам'яті)
const shares = new Map();
function serveShare(res, id) {
  const x = shares.get(id.replace(/\.jpg$/, ''));
  if (!x) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': x.buf.length, 'Cache-Control': 'public, max-age=86400' });
  res.end(x.buf);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (url.pathname === '/music.m4a') return serveMusic(req, res);
  if (SCRIPTS[url.pathname]) return serveScript(res, SCRIPTS[url.pathname]);
  if (url.pathname.startsWith('/avatar/')) { serveAvatar(res, url.pathname.slice(8)); return; }
  if (url.pathname.startsWith('/share/')) { serveShare(res, url.pathname.slice(7)); return; }
  if (url.pathname === '/tg/webhook' && req.method === 'POST') { onWebhook(req, res); return; }
  if (url.pathname === '/' || url.pathname === '/index.html') return serveIndex(res);
  res.writeHead(404); res.end('not found');
});

// ---------- Аватарки з Telegram ----------
const knownTg = new Set();
const photoUrls = new Map();
const avaCache = new Map();
const AVA_TTL = 6 * 3600 * 1000, AVA_MISS_TTL = 20 * 60 * 1000;
async function loadAvatar(id) {
  const c = avaCache.get(id);
  if (c && Date.now() - c.ts < (c.none ? AVA_MISS_TTL : AVA_TTL)) return c;
  let got = null;
  try {
    if (BOT_TOKEN) {
      const ph = await tg('getUserProfilePhotos', { user_id: +id, limit: 1 });
      const sizes = ph && ph.photos[0];
      if (sizes && sizes.length) {
        const pick = sizes.find(z => z.width >= 150) || sizes[sizes.length - 1];
        const f = await tg('getFile', { file_id: pick.file_id });
        if (f) {
          const r = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${f.file_path}`);
          if (r.ok) got = { buf: Buffer.from(await r.arrayBuffer()), type: 'image/jpeg' };
        }
      }
    }
  } catch (e) { console.log('avatar ' + id + ' (Bot API): ' + e.message); }
  try {
    if (!got && photoUrls.has(id)) {
      const r = await fetch(photoUrls.get(id));
      if (r.ok) got = { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'image/jpeg' };
    }
  } catch (e) { console.log('avatar ' + id + ' (photo_url): ' + e.message); }
  const entry = got && got.buf.length < 512 * 1024 ? { ...got, ts: Date.now() } : { none: true, ts: Date.now() };
  avaCache.set(id, entry);
  if (avaCache.size > 500) avaCache.delete(avaCache.keys().next().value);
  return entry;
}
async function serveAvatar(res, id) {
  if (!/^\d{1,20}$/.test(id) || !knownTg.has(id)) { res.writeHead(404); res.end(); return; }
  const a = await loadAvatar(id);
  if (a.none) { res.writeHead(404, { 'Cache-Control': 'public, max-age=600' }); res.end(); return; }
  res.writeHead(200, { 'Content-Type': a.type, 'Content-Length': a.buf.length, 'Cache-Control': 'public, max-age=21600' });
  res.end(a.buf);
}
const avatarOf = x => x && x.type === 'human' && x.id.startsWith('tg') ? '/avatar/' + x.id.slice(2) : null;

// ---------- Перевірка Telegram initData ----------
function checkInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dcs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const authDate = +params.get('auth_date');
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
  try {
    const u = JSON.parse(params.get('user'));
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Гравець';
    if (u.photo_url) photoUrls.set(String(u.id), u.photo_url);
    knownTg.add(String(u.id));
    return { id: 'tg' + u.id, name: name.slice(0, 24) };
  } catch (e) { return null; }
}

// ---------- Статистика ----------
let stats = {};           // id гравця → статистика (див. stats.js)
let statsDirty = false;
function statOf(id, name) {
  if (!stats[id]) stats[id] = Stats.blank(name);
  if (name) stats[id].name = name;
  return stats[id];
}
function sendAch(id, ids) {
  if (ids && ids.length) send(sockets.get(id), { t: 'ach', ids });
}
function statsAfterDeal(room, res) {
  for (let p = 0; p < room.n; p++) {
    const x = room.seats[p];
    if (!x || x.type !== 'human') continue;
    const st = statOf(x.id, x.name);
    sendAch(x.id, Stats.onDeal(st, Stats.dealFacts(res, room.n, p)));
  }
  statsDirty = true;
}
function statsAfterSeries(room) {
  const hs = room.seats.map((x, p) => x && x.type === 'human' ? { x, p } : null).filter(Boolean);
  for (const { x, p } of hs) {
    const st = statOf(x.id, x.name);
    sendAch(x.id, Stats.onSeries(st, { lost: Stats.seriesLost(room.ser, p), milk: room.ser.milk }));
    for (const o of hs) if (o.x.id !== x.id) st.friends[o.x.id] = (st.friends[o.x.id] || 0) + 1;
  }
  statsDirty = true;
}
function leaderboard(id) {
  const me = stats[id];
  const ids = [id, ...Object.keys(me ? me.friends : {})];
  const row = uid => {
    const s = stats[uid] || Stats.blank('');
    return { me: uid === id, name: s.name || 'Гравець', ava: uid.startsWith('tg') ? '/avatar/' + uid.slice(2) : null,
      games: s.games, wins: s.wins, goats: s.goats, milkGoats: s.milkGoats, together: me && me.friends[uid] || 0 };
  };
  return ids.filter((u, i) => ids.indexOf(u) === i && stats[u]).map(row)
    .sort((a, b) => b.goats - a.goats || (b.goats / Math.max(1, b.games)) - (a.goats / Math.max(1, a.games)) || b.games - a.games);
}

// ---------- Столи ----------
const rooms = new Map();
const userRoom = new Map();
const userLast = new Map();
const sockets = new Map();
const BOT_NAMES = ['Дядя Слава', 'Кум', 'Сват', 'Брат'];
function newCode() {
  for (;;) {
    const c = String(1000 + Math.floor(Math.random() * 9000));
    if (!rooms.has(c)) return c;
  }
}
function botName(room) {
  const used = new Set(room.seats.filter(x => x && x.type === 'bot').map(x => x.name));
  return BOT_NAMES.find(nm => !used.has(nm)) || 'Бот';
}
const humans = room => room.seats.filter(x => x && x.type === 'human');

// Стіл: гравці сідають по черзі (до 4). Скільки сіло — такий і формат: 2 — на двох, 3 — на трьох, 4 — пара на пару.
function createRoom(user, goal) {
  const room = {
    code: newCode(), n: 1, level: 'slava', goal: goal === 6 ? 6 : 12, hostId: user.id, ownerId: user.id,
    seats: [], status: 'lobby', ser: null, deal: null,
    ev: null, evSeq: 0, result: null, rec: null, reveal: null, ready: new Set(), timer: null, turnTimer: null, emptySince: null,
    chat: [], chatSeq: 0, duo: new Set(), absSig: '',
  };
  room.seats.push({ type: 'human', id: user.id, name: user.name, connected: true });
  rooms.set(room.code, room); userRoom.set(user.id, room.code); userLast.set(user.id, room.code);
  return room;
}
function seatOf(room, id) { return room.seats.findIndex(x => x && x.type === 'human' && x.id === id); }

// Стан гравця, якого немає: here / grace (щойно зник) / paused (гра чекає) / auto (грає бот)
function absence(x, now) {
  if (!x || x.type !== 'human' || x.connected) return 'here';
  const t = (now || Date.now()) - (x.awaySince || 0);
  return t < GRACE_MS ? 'grace' : t < AUTO_MS ? 'paused' : 'auto';
}
function markAway(x, now) { x.connected = false; x.awaySince = x.awaySince || now || Date.now(); }
function markBack(x) { x.connected = true; x.awaySince = null; x.left = false; }

function joinRoom(user, code) {
  const room = rooms.get(code);
  if (!room) return 'Стіл не знайдено. Перевірте код.';
  const cur = seatOf(room, user.id);
  if (cur >= 0) {
    const oldCode = userRoom.get(user.id);
    if (oldCode && oldCode !== code) leaveRoom(user.id);
    markBack(room.seats[cur]); room.seats[cur].name = user.name;
    room.emptySince = null; userRoom.set(user.id, code); userLast.set(user.id, code);
    return room;
  }
  if (room.status !== 'lobby') return 'За цим столом уже грають. Дочекайтеся кінця партії.';
  if (room.seats.length >= 4) return 'За столом уже 4 гравці.';
  leaveRoom(user.id);
  room.seats.push({ type: 'human', id: user.id, name: user.name, connected: true });
  room.n = room.seats.length;
  userRoom.set(user.id, code); userLast.set(user.id, code);
  return room;
}

function leaveRoom(id) {
  const code = userRoom.get(id);
  if (!code) return;
  userRoom.delete(id);
  const room = rooms.get(code);
  if (!room) return;
  const s = seatOf(room, id);
  if (s < 0) return;
  if (room.status === 'lobby' || room.status === 'over') {
    // вийшов до початку або після кінця партії — місце звільняється, решта лишається за столом
    room.seats.splice(s, 1); userLast.delete(id);
    if (room.status === 'over') { room.status = 'lobby'; room.ser = null; room.deal = null; room.result = null; room.rec = null; room.reveal = null; room.lastTrick = null; room.ready = new Set(); room.duo = new Set(); }
    room.n = Math.max(1, room.seats.length);
  } else {
    // вийшов сам через меню: без «запасних» 45 секунд, одразу пауза
    const x = room.seats[s]; x.left = true; x.connected = false; x.awaySince = Date.now() - GRACE_MS;
  }
  if (room.hostId === id) { const h = humans(room).find(x => x.connected); if (h) room.hostId = h.id; }
  if (!humans(room).some(x => x.connected)) room.emptySince = Date.now();
  if (room.status === 'lobby' && !humans(room).length) { rooms.delete(code); dirty(); presenceSoon(); return; }
  checkAbsence(room);
  broadcast(room);
  schedule(room);
}

// ---------- Вид столу для конкретного гравця ----------
function viewFor(room, id) {
  const n = room.n, s = Math.max(0, seatOf(room, id)), now = Date.now();
  const rot = p => (p - s + n) % n, unrot = r => (r + s) % n;
  const rotArr = a => a.map((_, r) => a[unrot(r)]);
  const swap = s % 2 === 1 && n === 4;
  const tArr = a => swap ? [a[1], a[0]] : a;
  const tIdx = t => swap ? 1 - t : t;
  const v = {
    t: 'room', code: room.code, n, status: room.status, level: room.level, goal: room.goal || 12,
    host: seatOf(room, id) >= 0, owner: canClose(room, id), mySeat: s,
    seats: room.seats.map(x => x && { id: x.type === 'human' ? x.id : null, name: x.name, ava: avatarOf(x), bot: x.type === 'bot', connected: x.type === 'bot' || x.connected, me: x.type === 'human' && x.id === id, host: x.type === 'human' && x.id === room.hostId }),
    names: room.seats.map((_, r) => { const x = room.seats[unrot(r)]; return x ? x.name : ''; }),
    online: room.seats.map((_, r) => { const x = room.seats[unrot(r)]; return !x || x.type === 'bot' || x.connected; }),
    auto: room.seats.map((_, r) => room.status !== 'lobby' && absence(room.seats[unrot(r)], now) === 'auto'),
    avas: room.seats.map((_, r) => avatarOf(room.seats[unrot(r)])),
    ready: [...room.ready].map(uid => seatOf(room, uid)).filter(i => i >= 0).map(rot),
    waiting: humans(room).filter(x => x.connected && !room.ready.has(x.id)).map(x => x.id === id ? 'ви' : x.name),
    // пауза: лише ті, кого немає довше 45 с, але ще менше 3 хв
    away: room.status === 'lobby' ? [] : room.seats.map((x, i) => absence(x, now) === 'paused'
      ? { i, name: x.name, autoAt: x.awaySince + AUTO_MS } : null).filter(Boolean),
    now, startedAt: room.startedAt || null,
    canDuo: canDuo(room) && seatOf(room, id) !== room.ser.losers[0],
    deadline: room.turnDeadline || null,
    invite: appLink(room.code),
  };
  if (room.ser) {
    const S = room.ser;
    const isTeam = n === 4;
    v.ser = {
      n, goal: S.goal, mult: S.mult, dealNo: S.dealNo, over: S.over, milk: S.milk,
      penalties: isTeam ? tArr(S.penalties) : rotArr(S.penalties),
      losers: isTeam ? S.losers.map(tIdx) : S.losers.map(rot),
      loser: S.loser < 0 ? -1 : (isTeam ? tIdx(S.loser) : rot(S.loser)),
    };
  }
  if (room.deal) {
    const d = room.deal;
    const trumpInStock = d.stock.length && d.stock[d.stock.length - 1] === d.trumpCard;
    const stock = new Array(d.stock.length).fill(-1);
    if (trumpInStock) stock[stock.length - 1] = d.trumpCard;
    const t = d.table;
    v.deal = {
      n, trump: d.trump, trumpCard: d.trumpCard, stock, phase: d.phase, attacker: rot(d.attacker), combo3: d.combo3 ? rotArr(d.combo3) : null,
      hands: d.hands.map((_, r) => r === 0 ? d.hands[s].slice() : new Array(d.hands[unrot(r)].length).fill(-1)),
      piles: d.hands.map(() => []),
      table: t && {
        attack: t.attack.slice(), by: rot(t.by), top: t.top.slice(), topBy: t.topBy === null ? null : rot(t.topBy),
        layers: t.layers.map(l => ({ p: rot(l.p), type: l.type, cards: l.type === 'discard' && l.p !== s ? l.cards.map(() => -1) : l.cards.slice() })),
        queue: t.queue.map(rot), interceptQueue: t.interceptQueue.map(rot),
        intercepted: t.intercepted, attackerWasCombo: t.attackerWasCombo,
      },
    };
    if (d.phase === 'resolve') v.deal.winner = rot(E.trickWinner(d));
  }
  // остання взятка: чужі скинуті карти лишаються закритими
  if (room.lastTrick && room.status === 'playing') v.lastTrick = { w: rot(room.lastTrick.w), cards: room.lastTrick.cards.map(([c, h, by]) => [h && by !== s ? -1 : c, h, rot(by)]) };
  if (room.ev) v.ev = { ...room.ev, p: room.ev.p === undefined ? undefined : rot(room.ev.p), seq: room.evSeq };
  if (room.result) {
    const r = room.result;
    v.result = n === 4
      ? { ...r, pts: rotArr(r.pts), teamPts: tArr(r.teamPts), pens: tArr(r.pens), bases: tArr(r.bases),
          loser: r.loser === undefined ? undefined : tIdx(r.loser), winners: r.winners.map(tIdx) }
      : { ...r, pts: rotArr(r.pts), pens: rotArr(r.pens), bases: rotArr(r.bases),
          loser: r.loser === undefined ? undefined : rot(r.loser), winners: r.winners.map(rot) };
    v.rec = { mult: room.rec.mult };
    // після роздачі всі бачать, хто що забрав (разом зі скинутими картами)
    if (room.reveal) v.reveal = rotArr(room.reveal);
  }
  return v;
}
function lastRoomFor(id) {
  const code = userLast.get(id), room = code && rooms.get(code);
  if (!room || room.status === 'lobby' || seatOf(room, id) < 0) return null;
  return { code, n: room.n, owner: canClose(room, id) };
}
// Закрити стіл може той, хто його створив (навіть якщо вийшов у меню), або поточний господар
const canClose = (room, id) => seatOf(room, id) >= 0 || room.ownerId === id;
function markBackIfSeated(room, id) { const i = seatOf(room, id); if (i >= 0 && !room.seats[i].connected) { markBack(room.seats[i]); checkAbsence(room); broadcast(room); schedule(room); } }
// ---------- Чат ----------
const lastChatAt = new Map();
function chatFor(room, id, m) {
  const s = Math.max(0, seatOf(room, id)), n = room.n;
  return { id: m.id, p: m.seat < 0 ? -1 : (m.seat - s + n) % n, name: m.name, text: m.text, ts: m.ts, mine: m.uid === id };
}
function sendChatHistory(room, id) {
  send(sockets.get(id), { t: 'chatHistory', code: room.code, list: room.chat.map(m => chatFor(room, id, m)) });
}
function postChat(room, user, text) {
  text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!text) return 'Порожнє повідомлення.';
  const now = Date.now();
  if (now - (lastChatAt.get(user.id) || 0) < 700) return 'Не так швидко 🙂';
  lastChatAt.set(user.id, now);
  const s = seatOf(room, user.id);
  const m = { id: ++room.chatSeq, seat: s, uid: user.id, name: user.name, text, ts: now };
  room.chat.push(m); if (room.chat.length > 60) room.chat.shift();
  for (const x of humans(room)) if (x.connected) send(sockets.get(x.id), { t: 'chat', code: room.code, m: chatFor(room, x.id, m) });
  dirty();
  return null;
}
function canDuo(room) {
  if (room.n !== 3 || room.status !== 'over' || !room.ser || room.ser.losers.length !== 1) return false;
  const goat = room.ser.losers[0];
  return room.ser.penalties.every((v, i) => i === goat || v < room.ser.goal);
}
function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room) {
  for (const x of humans(room)) if (x.connected) send(sockets.get(x.id), viewFor(room, x.id));
  dirty(); presenceSoon();
}

// ---------- Хід гри ----------
function startSeries(room) {
  room.n = room.seats.length;
  room.startedAt = Date.now();
  room.ser = E.newSeries(room.n, room.goal); room.result = null; room.rec = null;
  startDeal(room, true);
}
function startDeal(room, first) {
  room.deal = E.newDeal(rng, room.n, first, room.ser.nextStarter);
  room.status = 'playing'; room.result = null; room.rec = null; room.reveal = null; room.lastTrick = null; room.ready = new Set();
  room.ev = { t: 'deal', p: room.deal.attacker }; room.evSeq++;
  schedule(room, true); broadcast(room);
}
function startDuo(room, goat) {
  const out = room.seats[goat];
  const keep = room.seats.filter((_, i) => i !== goat);
  const pens = [0, 1, 2].filter(i => i !== goat).map(i => room.ser.penalties[i]);
  if (out && out.type === 'human') {
    userRoom.delete(out.id); userLast.delete(out.id);
    send(sockets.get(out.id), { t: 'error', msg: 'Ви козел. Інші догравають удвох.' });
    send(sockets.get(out.id), { t: 'left', lastRoom: null });
  }
  room.seats = keep;
  room.n = 2;
  room.duo = new Set(); room.ready = new Set();
  if (!keep.some(x => x.type === 'human' && x.id === room.hostId)) {
    const h = keep.find(x => x.type === 'human');
    if (h) room.hostId = h.id;
  }
  room.ser = E.newSeries(2, room.goal);
  room.ser.penalties = pens;
  startDeal(room, true);
}
function endDeal(room) {
  const res = E.dealResult(room.deal, room.ser.mult);
  room.reveal = room.deal.piles.map(pile => pile.map(e => [e.c, e.hidden ? 1 : 0]));
  const rec = E.applyDealToSeries(room.ser, res, room.deal.lastTrick);
  room.result = res; room.rec = rec; room.ready = new Set();
  room.status = room.ser.over ? 'over' : 'dealEnd';
  statsAfterDeal(room, res);
  if (room.ser.over) statsAfterSeries(room);
}
function doAction(room, p, a, auto) {
  clearTimeout(room.turnTimer);
  const seat = room.seats[p];
  E.applyAction(room.deal, a);
  if (a.type === 'intercept' && seat && seat.type === 'human' && !auto) {
    sendAch(seat.id, Stats.onIntercept(statOf(seat.id, seat.name))); statsDirty = true;
  }
  room.ev = { t: a.type, p, k: a.cards ? a.cards.length : 0, auto: !!auto }; room.evSeq++;
  schedule(room, true); broadcast(room);
}
function schedule(room, silent) {
  const prev = room.turnDeadline || null;
  planTurn(room);
  if (!silent && (room.turnDeadline || null) !== prev) broadcast(room);
}
// Бот (або автопілот за відсутнього) думає у фоновому потоці; якщо стан за цей час змінився — хід відкидаємо
function botMove(room, p, level, forced) {
  const d = room.deal, key = room.evSeq;
  if (room.thinking === key) return;
  room.thinking = key;
  const started = Date.now();
  Bots.choose(d, level, rng).then(a => {
    if (room.thinking === key) room.thinking = null;
    if (!rooms.has(room.code) || room.deal !== d || room.evSeq !== key || E.toAct(d) !== p || room.status !== 'playing') return;
    if (isPaused(room)) return; // після паузи planTurn попросить хід ще раз
    const wait = Math.max(0, 650 - (Date.now() - started));
    setTimeout(() => {
      if (room.deal === d && room.evSeq === key && E.toAct(d) === p && room.status === 'playing') doAction(room, p, a, forced);
    }, wait);
  });
}
function planTurn(room) {
  clearTimeout(room.timer); clearTimeout(room.turnTimer);
  const keep = room.turnDeadline && room.turnKey === room.evSeq ? room.turnDeadline : null;
  room.turnDeadline = null;
  if (room.status !== 'playing') return;
  if (isPaused(room)) { room.turnKey = null; return; }
  const d = room.deal;
  if (d.phase === 'resolve') {
    room.timer = setTimeout(() => {
      if (room.deal !== d || d.phase !== 'resolve') return;
      const t = d.table, lw = E.trickWinner(d);
      room.lastTrick = { w: lw, cards: t.attack.map(c => [c, 0, t.by]).concat(...t.layers.map(l => l.cards.map(c => [c, l.type === 'discard' ? 1 : 0, l.p]))) };
      const w = E.finishTrick(d);
      room.ev = { t: 'collected', p: w }; room.evSeq++;
      if (d.phase === 'dealEnd') endDeal(room);
      schedule(room, true); broadcast(room);
      if (room.status !== 'playing') maybeContinue(room);
    }, 1200);
    return;
  }
  if (d.phase === 'dealEnd') return;
  const p = E.toAct(d), seat = room.seats[p];
  if (seat.type === 'bot') { botMove(room, p, seat.level); return; }
  if (absence(seat) === 'auto') { botMove(room, p, room.level, true); return; }
  room.turnDeadline = keep || Date.now() + TURN_MS;
  room.turnKey = room.evSeq;
  room.turnTimer = setTimeout(() => {
    if (room.deal === d && E.toAct(d) === p) botMove(room, p, 'medium', true);
  }, Math.max(0, room.turnDeadline - Date.now()));
}
function isPaused(room) { return room.status !== 'lobby' && room.seats.some(x => absence(x) === 'paused'); }
function maybeContinue(room) {
  if (room.status !== 'dealEnd' && room.status !== 'over') return;
  if (isPaused(room)) { broadcast(room); return; }
  // ті, за кого грає бот, «готові» автоматично; хто щойно зник (до 45 с) — чекаємо
  const need = humans(room).filter(x => absence(x) !== 'auto');
  if (!humans(room).some(x => x.connected)) return;
  if (need.every(x => room.ready.has(x.id))) {
    if (room.status === 'over') startSeries(room); else startDeal(room, false);
  } else broadcast(room);
}
// Переходи «зник → пауза → бот» відстежуємо раз на кілька секунд
function checkAbsence(room) {
  if (room.status === 'lobby') { room.absSig = ''; return false; }
  const now = Date.now();
  const sig = room.seats.map(x => absence(x, now)[0]).join('');
  if (sig === room.absSig) return false;
  const prev = room.absSig || '';
  room.absSig = sig;
  room.seats.forEach((x, i) => {
    if (!x || x.type !== 'human') return;
    const was = prev[i], st = sig[i];
    if (st === 'p' && was !== 'p') notify(x.id, `«Боярський козел»: вас чекають за столом ${room.code}. Гру зупинено, поки ви не повернетесь.`, room.code, true);
    if (st === 'a' && was !== 'a') notify(x.id, `За столом ${room.code} за вас тимчасово грає бот. Поверніться будь-коли — продовжите самі.`, room.code, true);
  });
  return true;
}

// ---------- Повідомлення від гравців ----------
function sameCards(a, b) { return a.length === b.length && a.every(c => b.includes(c)); }
const seatIdx = (room, i) => Number.isInteger(i) && i >= 0 && i < room.seats.length ? i : -1;
function handle(ws, user, m) {
  const code = userRoom.get(user.id), room = code && rooms.get(code);
  switch (m.t) {
    case 'table': // «Грати з друзями»: повертаємо ваш стіл або створюємо новий
    case 'create': {
      if (room) { markBackIfSeated(room, user.id); send(ws, viewFor(room, user.id)); sendChatHistory(room, user.id); return; }
      const nr = createRoom(user, m.goal);
      broadcast(nr); sendChatHistory(nr, user.id);
      return;
    }
    case 'join': {
      const r = joinRoom(user, String(m.code || '').replace(/\D/g, '').slice(0, 4));
      if (typeof r === 'string') return send(ws, { t: 'error', msg: r });
      checkAbsence(r); broadcast(r); sendChatHistory(r, user.id); schedule(r); maybeContinue(r);
      return;
    }
    case 'leave': { leaveRoom(user.id); send(ws, { t: 'left', lastRoom: lastRoomFor(user.id) }); presenceSoon(); return; }
    case 'ping': return send(ws, { t: 'pong', ts: m.ts });
    case 'end':
    case 'close': { // будь-хто за столом може завершити гру для всіх
      const cr = rooms.get(String(m.code || code || ''));
      if (!cr) { send(ws, { t: 'left', lastRoom: null }); return; }
      if (!canClose(cr, user.id)) return send(ws, { t: 'error', msg: 'Ви не за цим столом.' });
      const inside = seatOf(cr, user.id) >= 0;
      closeRoom(cr, user.name);
      if (!inside) send(ws, { t: 'left', lastRoom: null });
      return;
    }
    case 'invite': return invite(ws, user, m);
    case 'inviteReply': {
      if (!m.ok && typeof m.to === 'string') send(sockets.get(m.to), { t: 'inviteDeclined', name: user.name });
      return;
    }
    case 'stats': {
      send(ws, { t: 'stats', me: stats[user.id] || Stats.blank(user.name), board: leaderboard(user.id) });
      return;
    }
    case 'share': return shareImage(ws, user, m);
  }
  if (!room) return send(ws, { t: 'error', msg: 'Ви не за столом.' });
  const s = seatOf(room, user.id), isHost = s >= 0; // усі, хто за столом, мають рівні права
  switch (m.t) {
    case 'bot': // посадити Дядю Славу (чи іншого бота) на вільне місце
      if (isHost && room.status === 'lobby' && room.seats.length < 4) {
        room.seats.push({ type: 'bot', level: room.level, name: botName(room) }); room.n = room.seats.length; broadcast(room);
      }
      return;
    case 'unbot': {
      const i = seatIdx(room, m.i);
      if (i >= 0 && isHost && room.status === 'lobby' && room.seats[i].type === 'bot') { room.seats.splice(i, 1); room.n = Math.max(1, room.seats.length); broadcast(room); }
      return;
    }
    case 'goal':
      if (isHost && room.status === 'lobby' && (m.goal === 6 || m.goal === 12)) { room.goal = m.goal; broadcast(room); }
      return;
    case 'level': // рівень ботів один — «Дядя Слава»
      if (false) {
        room.level = m.level; for (const x of room.seats) if (x && x.type === 'bot') x.level = m.level; broadcast(room);
      }
      return;
    case 'start':
      if (isHost && room.status === 'lobby' && room.seats.length >= 2) startSeries(room);
      return;
    case 'act': {
      // повторна відправка того самого ходу після обриву зв'язку — не помилка, просто надсилаємо поточний стан
      if (m.id && lastActId.get(user.id) === m.id) return send(ws, viewFor(room, user.id));
      if (m.id) lastActId.set(user.id, m.id);
      if (room.status === 'playing' && isPaused(room)) return send(ws, { t: 'error', msg: 'Гру зупинено: чекаємо, поки гравець повернеться.' });
      if (room.status !== 'playing' || E.toAct(room.deal) !== s) return send(ws, { t: 'error', msg: 'Зараз не ваш хід.' });
      const a = m.a || {};
      const legal = E.legalActions(room.deal).find(x => x.type === a.type && (!x.cards || (Array.isArray(a.cards) && sameCards(x.cards, a.cards))));
      if (!legal) return send(ws, { t: 'error', msg: 'Такий хід неможливий.' });
      room.thinking = null;
      doAction(room, s, legal);
      return;
    }
    case 'ready':
      room.ready.add(user.id); maybeContinue(room);
      return;
    case 'duo': {
      if (!canDuo(room)) return;
      const goat = room.ser.losers[0];
      if (s < 0 || s === goat) return;
      room.duo.add(user.id);
      const need = room.seats.filter((x, i) => x && x.type === 'human' && i !== goat && x.connected);
      if (need.every(x => room.duo.has(x.id))) startDuo(room, goat); else broadcast(room);
      return;
    }
    case 'chat': {
      if (s < 0) return;
      const err = postChat(room, user, m.text);
      if (err) send(ws, { t: 'error', msg: err });
      return;
    }
    case 'replace': {
      const i = seatIdx(room, m.i), x = i >= 0 ? room.seats[i] : null;
      if (!isHost || room.status === 'lobby' || !x || x.type !== 'human' || x.connected) return;
      userRoom.delete(x.id); userLast.delete(x.id); room.ready.delete(x.id);
      room.seats[i] = { type: 'bot', level: room.level, name: botName(room) };
      checkAbsence(room); broadcast(room); schedule(room); maybeContinue(room);
      return;
    }
  }
}

// ---------- «Поділитися результатом» ----------
// Сторінка малює картинку, сервер тримає її 24 год і готує повідомлення для кнопки «Поділитися» в Telegram
async function shareImage(ws, user, m) {
  const mm = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(m.img || ''));
  if (!mm) return send(ws, { t: 'shareReady', err: 'Не вдалося підготувати картинку.' });
  const buf = Buffer.from(mm[1], 'base64');
  if (buf.length > 600 * 1024) return send(ws, { t: 'shareReady', err: 'Картинка завелика.' });
  const id = crypto.randomBytes(9).toString('hex');
  shares.set(id, { buf, ts: Date.now() });
  if (shares.size > 200) shares.delete(shares.keys().next().value);
  const url = PUBLIC_URL ? `${PUBLIC_URL}/share/${id}.jpg` : null;
  let prepared = null;
  const caption = String(m.text || '').slice(0, 900);
  if (url && user.id.startsWith('tg')) {
    const link = appLink();
    const r = await tg('savePreparedInlineMessage', {
      user_id: +user.id.slice(2),
      result: { type: 'photo', id, photo_url: url, thumbnail_url: url, caption: caption + (link ? `\n\nГрай: ${link}` : '') },
      allow_user_chats: true, allow_bot_chats: true, allow_group_chats: true, allow_channel_chats: true,
    });
    if (r) prepared = r.id;
  }
  send(ws, { t: 'shareReady', url, prepared, link: appLink() });
}

// ---------- Бот у Telegram: /start, /stats, /help ----------
async function onWebhook(req, res) {
  if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) { res.writeHead(403); res.end(); return; }
  let upd;
  try { upd = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8')); } catch (e) { res.writeHead(400); res.end(); return; }
  res.writeHead(200); res.end('ok');
  const msg = upd.message;
  if (!msg || !msg.text || !msg.chat || msg.chat.type !== 'private') return;
  const uid = 'tg' + msg.from.id;
  const [cmd, arg] = msg.text.trim().split(/\s+/);
  const link = appLink();
  const playBtn = code => ({ inline_keyboard: [[{ text: code ? `Сісти за стіл ${code}` : '🃏 Грати', url: appLink(code) || link }]] });
  if (/^\/stats/.test(cmd)) {
    const s = stats[uid];
    const text = s && s.games
      ? `Ваша статистика онлайн:\nПартій: ${s.games}\nПеремог: ${s.wins}\nКозел: ${s.goats} (молочний: ${s.milkGoats})\nНайкраща серія: ${s.bestStreak}\nНагород: ${Object.keys(s.ach).length} з ${Stats.ACH.length}`
      : 'Ви ще не зіграли жодної онлайн-партії.';
    tg('sendMessage', { chat_id: msg.chat.id, text, reply_markup: link ? playBtn() : undefined });
    return;
  }
  if (/^\/help/.test(cmd)) {
    tg('sendMessage', { chat_id: msg.chat.id, text: 'Боярський козел — карткова гра на 2, 3 або 4 гравці (пара на пару). Грайте з ботами або створіть стіл і надішліть друзям запрошення. Правила — у меню гри.\n\n/stats — ваша статистика', reply_markup: link ? playBtn() : undefined });
    return;
  }
  if (/^\/start/.test(cmd)) {
    const code = /^\d{4}$/.test(arg || '') ? arg : null;
    tg('sendMessage', {
      chat_id: msg.chat.id,
      text: '🐐 «Боярський козел»\n\nГрайте з ботами або з друзями онлайн. Тут бот повідомлятиме, коли вас чекають за столом.\n\n/stats — ваша статистика\n/help — коротко про гру',
      reply_markup: link ? playBtn(code) : undefined,
    });
  }
}

// ---------- З'єднання ----------
// ---------- Хто зараз у грі, запрошення, закриття столу ----------
const lastActId = new Map();
const lastInvite = new Map();
function statusOf(id) {
  const room = rooms.get(userRoom.get(id));
  if (!room) return 'free';
  return room.status === 'lobby' ? 'lobby' : 'playing';
}
function presenceList() {
  const out = [];
  for (const [id, ws] of sockets) if (ws.readyState === 1 && ws.user) out.push({ id, name: ws.user.name, ava: id.startsWith('tg') ? '/avatar/' + id.slice(2) : null, status: statusOf(id) });
  return out.sort((a, b) => (a.status === 'free' ? 0 : 1) - (b.status === 'free' ? 0 : 1) || a.name.localeCompare(b.name));
}
let presenceTimer = null, presenceSig = '';
function presenceSoon() {
  if (presenceTimer) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    const list = presenceList(), sig = JSON.stringify(list) + Object.keys(stats).length;
    if (sig === presenceSig) return;
    presenceSig = sig;
    for (const [id, ws] of sockets) {
      const fr = (stats[id] && stats[id].friends) || {};
      const mine = list.map(u => ({ ...u, me: u.id === id, friend: !!fr[u.id] }))
        .sort((a, b) => (b.me - a.me) || (b.friend - a.friend) || ((a.status === 'free' ? 0 : 1) - (b.status === 'free' ? 0 : 1)) || a.name.localeCompare(b.name));
      send(ws, { t: 'presence', list: mine });
    }
  }, 700);
}
function invite(ws, user, m) {
  const now = Date.now();
  if (now - (lastInvite.get(user.id) || 0) < 2000) return send(ws, { t: 'error', msg: 'Зачекайте трохи перед наступним запрошенням.' });
  lastInvite.set(user.id, now);
  const to = typeof m.to === 'string' ? m.to : '';
  const tws = sockets.get(to);
  if (!tws || to === user.id) return send(ws, { t: 'error', msg: 'Гравець уже вийшов з гри.' });
  if (statusOf(to) !== 'free') return send(ws, { t: 'error', msg: 'Гравець зараз грає за іншим столом.' });
  let room = rooms.get(userRoom.get(user.id));
  if (room && room.status !== 'lobby') return send(ws, { t: 'error', msg: 'Покликати можна до початку партії.' });
  if (room && room.seats.length >= 4) return send(ws, { t: 'error', msg: 'За столом уже 4 гравці.' });
  if (!room) {
    room = createRoom(user, m.goal);
    broadcast(room); sendChatHistory(room, user.id);
  }
  send(tws, { t: 'invited', code: room.code, n: room.n, from: { id: user.id, name: user.name } });
  send(ws, { t: 'inviteSent', name: tws.user ? tws.user.name : '' });
  presenceSoon();
}
function closeRoom(room, byName) {
  clearTimeout(room.timer); clearTimeout(room.turnTimer);
  for (const x of humans(room)) {
    if (userRoom.get(x.id) === room.code) userRoom.delete(x.id);
    if (userLast.get(x.id) === room.code) userLast.delete(x.id);
    const xs = sockets.get(x.id);
    send(xs, { t: 'closed', code: room.code, by: byName });
    send(xs, { t: 'left', lastRoom: null });
  }
  rooms.delete(room.code); dirty(); presenceSoon();
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });
wss.on('connection', ws => {
  let user = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!user) {
      if (m.t !== 'hello') return;
      user = checkInitData(m.initData);
      if (!user && ALLOW_GUESTS && m.guest && /^[\w-]{6,40}$/.test(m.guest.id)) {
        user = { id: 'g_' + m.guest.id, name: String(m.guest.name || 'Гість').slice(0, 24) };
      }
      if (!user) { send(ws, { t: 'error', msg: 'Відкрийте гру через Telegram.' }); ws.close(); return; }
      const old = sockets.get(user.id);
      if (old && old !== ws) old.close();
      sockets.set(user.id, ws); ws.user = user;
      if (stats[user.id]) stats[user.id].name = user.name;
      presenceSoon();
      send(ws, { t: 'welcome', me: user, lastRoom: userRoom.has(user.id) ? null : lastRoomFor(user.id) });
      const code = userRoom.get(user.id), room = code && rooms.get(code);
      if (room) {
        const s = seatOf(room, user.id);
        if (s >= 0) { markBack(room.seats[s]); room.emptySince = null; }
        checkAbsence(room); broadcast(room); sendChatHistory(room, user.id); schedule(room); maybeContinue(room);
      }
      if (m.join) {
        const r = joinRoom(user, String(m.join).replace(/\D/g, '').slice(0, 4));
        if (typeof r === 'string') send(ws, { t: 'error', msg: r });
        else { checkAbsence(r); broadcast(r); sendChatHistory(r, user.id); schedule(r); maybeContinue(r); }
      }
      return;
    }
    ws.isAlive = true; // будь-яке повідомлення = з'єднання живе
    const t0 = Date.now();
    try { handle(ws, user, m); } catch (e) { console.error(e); send(ws, { t: 'error', msg: 'Помилка сервера.' }); }
    const dt = Date.now() - t0;
    if (dt > 150) console.log(`повільно: ${m.t} ${dt} мс`);
  });
  ws.on('close', () => {
    if (!user || sockets.get(user.id) !== ws) return;
    sockets.delete(user.id); presenceSoon();
    const code = userRoom.get(user.id), room = code && rooms.get(code);
    if (!room) return;
    const s = seatOf(room, user.id);
    if (s < 0) return;
    if (room.status === 'lobby') { leaveRoom(user.id); return; }
    markAway(room.seats[s]);
    if (!humans(room).some(x => x.connected)) room.emptySince = Date.now();
    checkAbsence(room); broadcast(room); schedule(room);
  });
});

// ---------- Збереження столів і статистики ----------
let roomsDirty = false;
function dirty() { roomsDirty = true; }
function packRoom(r) {
  return {
    code: r.code, n: r.n, level: r.level, goal: r.goal, hostId: r.hostId, ownerId: r.ownerId || r.hostId, status: r.status,
    seats: r.seats.map(x => x && { ...x }), ser: r.ser, deal: r.deal ? E.packState(r.deal) : null,
    ev: r.ev, evSeq: r.evSeq, result: r.result, rec: r.rec, reveal: r.reveal, lastTrick: r.lastTrick || null, ready: [...r.ready],
    chat: r.chat, chatSeq: r.chatSeq, duo: [...r.duo], startedAt: r.startedAt || null, emptySince: r.emptySince,
  };
}
function unpackRoom(o) {
  const now = Date.now();
  const room = { ...o, deal: o.deal ? E.unpackState(o.deal) : null, ready: new Set(o.ready), duo: new Set(o.duo),
    timer: null, turnTimer: null, turnDeadline: null, absSig: '', thinking: null };
  // після перезапуску всі люди «щойно зникли» — у них є звичайний час повернутися
  for (const x of room.seats) if (x && x.type === 'human') {
    x.connected = false; x.awaySince = now;
    if (x.id.startsWith('tg')) knownTg.add(x.id.slice(2));
  }
  room.emptySince = now;
  return room;
}
async function saveRooms() {
  if (!roomsDirty) return;
  roomsDirty = false;
  await Store.set('rooms', [...rooms.values()].filter(r => r.status !== 'lobby').map(packRoom));
}
async function saveStats() {
  if (!statsDirty) return;
  statsDirty = false;
  await Store.set('stats', stats);
}
async function restore() {
  const st = await Store.get('stats');
  if (st && typeof st === 'object') stats = st;
  for (const id of Object.keys(stats)) if (id.startsWith('tg')) knownTg.add(id.slice(2));
  const list = await Store.get('rooms');
  if (Array.isArray(list)) for (const o of list) {
    try {
      const room = unpackRoom(o);
      rooms.set(room.code, room);
      for (const x of room.seats) if (x && x.type === 'human') { userRoom.set(x.id, room.code); userLast.set(x.id, room.code); }
      checkAbsence(room);
    } catch (e) { console.log('Не вдалося відновити стіл ' + (o && o.code) + ': ' + e.message); }
  }
  if (rooms.size) console.log(`Відновлено столів: ${rooms.size} (сховище: ${Store.kind})`);
}

setInterval(() => { saveRooms(); saveStats(); }, 3000);
async function shutdown() {
  roomsDirty = true; statsDirty = true;
  try { await Promise.race([Promise.all([saveRooms(), saveStats()]), new Promise(r => setTimeout(r, 4000))]); } catch (e) {}
  Store.flushFile();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Раз на 3 с: переходи відсутності (пауза / бот), таймери
setInterval(() => {
  for (const room of rooms.values()) {
    if (checkAbsence(room)) { broadcast(room); schedule(room); maybeContinue(room); }
  }
}, 1500);
// Перевірка «мертвих» з'єднань кожні 10 с (мобільний інтернет рветься без попередження)
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
}, 10000);
// Прибирання покинутих столів і картинок
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.emptySince && now - room.emptySince > EMPTY_TTL) {
      clearTimeout(room.timer); clearTimeout(room.turnTimer);
      for (const x of humans(room)) { if (userRoom.get(x.id) === code) userRoom.delete(x.id); if (userLast.get(x.id) === code) userLast.delete(x.id); }
      rooms.delete(code); dirty();
    }
  }
  for (const [id, x] of shares) if (now - x.ts > 86400000) shares.delete(id);
  for (const [id, t] of lastChatAt) if (now - t > 3600000) lastChatAt.delete(id);
  for (const id of lastActId.keys()) if (!sockets.has(id)) lastActId.delete(id);
}, 25000);

// Безкоштовний Render «засинає» після 15 хв без запитів — стукаємо самі до себе раз на 10 хв
if (KEEP_AWAKE && PUBLIC_URL) {
  setInterval(() => { fetch(PUBLIC_URL + '/health').catch(() => {}); }, 10 * 60 * 1000);
  console.log('Самопінг увімкнено: ' + PUBLIC_URL + '/health кожні 10 хв');
}

restore().then(() => {
  server.listen(PORT, () => {
    console.log('Боярський козел слухає порт ' + PORT + (ALLOW_GUESTS ? ' (гості дозволені)' : '') + ', сховище: ' + Store.kind);
    for (const room of rooms.values()) schedule(room, true);
    if (BOT_TOKEN && PUBLIC_URL && process.env.WEBHOOK !== '0') {
      tg('setWebhook', { url: PUBLIC_URL + '/tg/webhook', secret_token: WEBHOOK_SECRET, allowed_updates: ['message'] })
        .then(r => r && console.log('Вебхук бота встановлено'));
      tg('setMyCommands', { commands: [
        { command: 'start', description: 'Грати' }, { command: 'stats', description: 'Моя статистика' }, { command: 'help', description: 'Про гру' },
      ] });
    }
  });
});
