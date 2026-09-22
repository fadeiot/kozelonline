// ===== Боярський козел: онлайн-сервер =====
// Роздає сторінку гри та тримає столи для гри з друзями через WebSocket.
// Змінні середовища (Render → Environment):
//   BOT_TOKEN     — токен бота від @BotFather (для перевірки, що гравець справді з Telegram)
//   BOT_USERNAME  — логін бота без @, напр. boyarskyi_kozel_bot (для посилань-запрошень)
//   APP_NAME      — коротка назва Mini App з /newapp, напр. play
//   ALLOW_GUESTS  — 1, щоб дозволити гру з браузера без Telegram (для перевірки)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const E = require('./engine.js');
const AI = require('./ai.js');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
let BOT_USERNAME = (process.env.BOT_USERNAME || '').replace(/^@/, '');
// Справжній логін бота беремо прямо в Telegram за токеном, щоб посилання-запрошення не ламались через помилку в налаштуваннях
if (process.env.BOT_TOKEN && typeof fetch === 'function') {
  fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getMe`)
    .then(r => r.json())
    .then(j => {
      if (j && j.ok && j.result && j.result.username) {
        if (BOT_USERNAME && BOT_USERNAME.toLowerCase() !== j.result.username.toLowerCase())
          console.log(`BOT_USERNAME у налаштуваннях (${BOT_USERNAME}) не збігається з ботом (${j.result.username}), використовую ${j.result.username}`);
        BOT_USERNAME = j.result.username;
        console.log('Бот: @' + BOT_USERNAME);
      } else console.log('getMe: не вдалося отримати логін бота, перевірте BOT_TOKEN');
    })
    .catch(e => console.log('getMe помилка: ' + e.message));
}
const APP_NAME = process.env.APP_NAME || '';
const ALLOW_GUESTS = !BOT_TOKEN || process.env.ALLOW_GUESTS === '1';

// На безкоштовному сервері процесор слабкий: сильний бот думає не довше 400 мс
AI.LEVELS.hard.timeMs = 400;
AI.LEVELS.slava.timeMs = 900;
const rng = E.mulberry32((Date.now() ^ (Math.random() * 1e9)) >>> 0);

// ---------- Сторінка гри ----------
// Сторінку шукаємо і в папці public, і поруч із server.js (якщо GitHub завантажив файли без папки)
const INDEX_PATHS = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')];
function serveIndex(res) {
  const file = INDEX_PATHS.find(f => fs.existsSync(f));
  if (!file) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Не знайдено index.html. Завантажте його в репозиторій поруч із server.js.');
    return;
  }
  fs.readFile(file, 'utf8', (err, html) => {
    if (err) { res.writeHead(500); res.end('index.html read error'); return; }
    const cfg = `<script>window.KOZEL_ONLINE=${JSON.stringify({ bot: BOT_USERNAME, app: APP_NAME, guests: ALLOW_GUESTS })};</script>`;
    html = html.replace('<script', cfg + '\n<script');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(html);
  });
}
// Фонова музика: лежить поруч із server.js (або в public). iPhone вимагає підтримки Range-запитів.
const MUSIC_PATHS = [path.join(__dirname, 'music.m4a'), path.join(__dirname, 'public', 'music.m4a')];
function serveMusic(req, res) {
  const file = MUSIC_PATHS.find(f => fs.existsSync(f));
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
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (url.pathname === '/music.m4a') return serveMusic(req, res);
  if (url.pathname.startsWith('/avatar/')) { serveAvatar(res, url.pathname.slice(8)); return; }
  if (url.pathname === '/' || url.pathname === '/index.html') return serveIndex(res);
  res.writeHead(404); res.end('not found');
});

// ---------- Аватарки з Telegram ----------
// Фото профілю беремо через Bot API (токен не потрапляє до гравців) і віддаємо за адресою /avatar/<id>.
const knownTg = new Set();        // лише гравці, які заходили в гру (щоб сервер не став чужим проксі)
const photoUrls = new Map();      // id → photo_url з initData (запасний варіант)
const avaCache = new Map();       // id → { buf, type, ts } або { none: true, ts }
const AVA_TTL = 6 * 3600 * 1000, AVA_MISS_TTL = 20 * 60 * 1000;
async function loadAvatar(id) {
  const c = avaCache.get(id);
  if (c && Date.now() - c.ts < (c.none ? AVA_MISS_TTL : AVA_TTL)) return c;
  let got = null;
  try {
    if (BOT_TOKEN) {
      const api = `https://api.telegram.org/bot${BOT_TOKEN}`;
      const ph = await (await fetch(`${api}/getUserProfilePhotos?user_id=${id}&limit=1`)).json();
      const sizes = ph.ok && ph.result.photos[0];
      if (sizes && sizes.length) {
        const pick = sizes.find(z => z.width >= 150) || sizes[sizes.length - 1];
        const f = await (await fetch(`${api}/getFile?file_id=${encodeURIComponent(pick.file_id)}`)).json();
        if (f.ok) {
          const r = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${f.result.file_path}`);
          if (r.ok) got = { buf: Buffer.from(await r.arrayBuffer()), type: 'image/jpeg' };
        }
      }
    }
  } catch (e) { console.log('avatar ' + id + ' (Bot API): ' + e.message); }
  // запасний варіант: photo_url, який Telegram передав у даних міні-застосунку
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

// ---------- Столи ----------
const rooms = new Map();          // код → стіл
const userRoom = new Map();       // id гравця → код столу, за яким він зараз
const userLast = new Map();       // id гравця → стіл, з якого він вийшов (щоб повернутися)
const sockets = new Map();        // id гравця → WebSocket
const BOT_NAMES = ['Кум', 'Сват', 'Брат', 'Дядько'];
// Код столу — 4 цифри (1000–9999), його легко ввести з цифрової клавіатури
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

function createRoom(user, n, level) {
  const room = {
    code: newCode(), n, level: AI.LEVELS[level] ? level : 'medium', hostId: user.id,
    seats: new Array(n).fill(null), status: 'lobby', ser: null, deal: null,
    ev: null, evSeq: 0, result: null, rec: null, ready: new Set(), timer: null, turnTimer: null, emptySince: null,
    chat: [], chatSeq: 0,
  };
  room.seats[0] = { type: 'human', id: user.id, name: user.name, connected: true };
  rooms.set(room.code, room); userRoom.set(user.id, room.code); userLast.set(user.id, room.code);
  return room;
}
function seatOf(room, id) { return room.seats.findIndex(x => x && x.type === 'human' && x.id === id); }

function joinRoom(user, code) {
  const room = rooms.get(code);
  if (!room) return 'Стіл не знайдено. Перевірте код.';
  const cur = seatOf(room, user.id);
  if (cur >= 0) {
    const oldCode = userRoom.get(user.id);
    if (oldCode && oldCode !== code) leaveRoom(user.id);
    Object.assign(room.seats[cur], { connected: true, left: false, name: user.name });
    room.emptySince = null; userRoom.set(user.id, code); userLast.set(user.id, code);
    return room;
  }
  if (room.status !== 'lobby') return 'Гра за цим столом уже йде.';
  const free = room.seats.findIndex(x => x === null);
  if (free < 0) return 'Усі місця зайняті.';
  leaveRoom(user.id);
  room.seats[free] = { type: 'human', id: user.id, name: user.name, connected: true };
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
  if (room.status === 'lobby') { room.seats[s] = null; userLast.delete(id); }
  else { room.seats[s].connected = false; room.seats[s].left = true; }
  if (room.hostId === id) { const h = humans(room).find(x => x.connected && !x.left); if (h) room.hostId = h.id; }
  if (!humans(room).some(x => x.connected)) room.emptySince = Date.now();
  if (room.status === 'lobby' && !humans(room).length) { rooms.delete(code); return; }
  broadcast(room);
  schedule(room);
}

// ---------- Вид столу для конкретного гравця (свої карти бачить лише він) ----------
function viewFor(room, id) {
  const n = room.n, s = Math.max(0, seatOf(room, id));
  const rot = p => (p - s + n) % n, unrot = r => (r + s) % n;
  const rotArr = a => a.map((_, r) => a[unrot(r)]);
  const swap = s % 2 === 1 && n === 4;
  const tArr = a => swap ? [a[1], a[0]] : a;
  const tIdx = t => swap ? 1 - t : t;
  const v = {
    t: 'room', code: room.code, n, status: room.status, level: room.level,
    host: room.hostId === id, mySeat: s,
    seats: room.seats.map((x, i) => x && { name: x.name, ava: avatarOf(x), bot: x.type === 'bot', connected: x.type === 'bot' || x.connected, me: x.type === 'human' && x.id === id, host: x.type === 'human' && x.id === room.hostId }),
    names: room.seats.map((_, r) => { const x = room.seats[unrot(r)]; return x ? x.name : ''; }),
    online: room.seats.map((_, r) => { const x = room.seats[unrot(r)]; return !x || x.type === 'bot' || x.connected; }),
    avas: room.seats.map((_, r) => avatarOf(room.seats[unrot(r)])),
    ready: [...room.ready].map(uid => seatOf(room, uid)).filter(i => i >= 0).map(rot),
    waiting: humans(room).filter(x => x.connected && !room.ready.has(x.id)).map(x => x.id === id ? 'ви' : x.name),
    away: room.status === 'lobby' ? [] : room.seats.map((x, i) => x && x.type === 'human' && !x.connected ? { i, name: x.name } : null).filter(Boolean),
    now: Date.now(), startedAt: room.startedAt || null,
    deadline: room.turnDeadline || null,
    invite: BOT_USERNAME && APP_NAME ? `https://t.me/${BOT_USERNAME}/${APP_NAME}?startapp=${room.code}` : null,
  };
  if (room.ser) {
    const S = room.ser;
    const isTeam = n === 4;
    v.ser = {
      n, mult: S.mult, dealNo: S.dealNo, over: S.over, milk: S.milk,
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
      n, trump: d.trump, trumpCard: d.trumpCard, stock, phase: d.phase, attacker: rot(d.attacker),
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
  if (room.ev) v.ev = { ...room.ev, p: room.ev.p === undefined ? undefined : rot(room.ev.p), seq: room.evSeq };
  if (room.result) {
    const r = room.result;
    v.result = n === 4
      ? { ...r, pts: rotArr(r.pts), teamPts: tArr(r.teamPts), pens: tArr(r.pens), bases: tArr(r.bases),
          loser: r.loser === undefined ? undefined : tIdx(r.loser), winners: r.winners.map(tIdx) }
      : { ...r, pts: rotArr(r.pts), pens: rotArr(r.pens), bases: rotArr(r.bases),
          loser: r.loser === undefined ? undefined : rot(r.loser), winners: r.winners.map(rot) };
    v.rec = { mult: room.rec.mult };
  }
  return v;
}
// Стіл, до якого гравець може повернутися (він там досі має місце)
function lastRoomFor(id) {
  const code = userLast.get(id), room = code && rooms.get(code);
  if (!room || room.status === 'lobby' || seatOf(room, id) < 0) return null;
  return { code, n: room.n };
}
// ---------- Чат ----------
const lastChatAt = new Map(); // id → час останнього повідомлення (захист від флуду)
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
  return null;
}
function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room) {
  for (const x of humans(room)) if (x.connected) send(sockets.get(x.id), viewFor(room, x.id));
}

// ---------- Хід гри ----------
const TURN_MS = 60000; // на хід — 1 хвилина, далі за гравця ходить бот
function startSeries(room) {
  room.startedAt = Date.now();
  room.ser = E.newSeries(room.n); room.result = null; room.rec = null;
  startDeal(room, true);
}
function startDeal(room, first) {
  room.deal = E.newDeal(rng, room.n, first, room.ser.nextStarter);
  room.status = 'playing'; room.result = null; room.rec = null; room.ready = new Set();
  room.ev = { t: 'deal', p: room.deal.attacker }; room.evSeq++;
  schedule(room, true); broadcast(room);
}
function endDeal(room) {
  const res = E.dealResult(room.deal, room.ser.mult);
  const rec = E.applyDealToSeries(room.ser, res, room.deal.lastTrick);
  room.result = res; room.rec = rec; room.ready = new Set();
  room.status = room.ser.over ? 'over' : 'dealEnd';
}
function doAction(room, p, a, auto) {
  clearTimeout(room.turnTimer);
  E.applyAction(room.deal, a);
  room.ev = { t: a.type, p, k: a.cards ? a.cards.length : 0, auto: !!auto }; room.evSeq++;
  schedule(room, true); broadcast(room);
}
// silent = true: виклик із місця, яке саме розішле стан; інакше розсилаємо, якщо змінився таймер ходу
function schedule(room, silent) {
  const prev = room.turnDeadline || null;
  planTurn(room);
  if (!silent && (room.turnDeadline || null) !== prev) broadcast(room);
}
function planTurn(room) {
  clearTimeout(room.timer); clearTimeout(room.turnTimer);
  const keep = room.turnDeadline && room.turnKey === room.evSeq ? room.turnDeadline : null;
  room.turnDeadline = null;
  if (room.status !== 'playing') return;
  if (isPaused(room)) { room.turnKey = null; return; } // хтось із людей вийшов — гра стоїть, доки не повернеться
  const d = room.deal;
  if (d.phase === 'resolve') {
    room.timer = setTimeout(() => {
      const w = E.finishTrick(d);
      room.ev = { t: 'collected', p: w }; room.evSeq++;
      if (d.phase === 'dealEnd') endDeal(room);
      schedule(room, true); broadcast(room);
    }, 1500);
    return;
  }
  if (d.phase === 'dealEnd') return;
  const p = E.toAct(d), seat = room.seats[p];
  const auto = (level, forced) => () => { if (room.deal === d && E.toAct(d) === p) doAction(room, p, AI.chooseAction(d, level, rng), forced); };
  if (seat.type === 'bot') { room.timer = setTimeout(auto(seat.level), 650); return; }
  // людина: 1 хвилина на хід (якщо стан не змінився — таймер не скидаємо)
  room.turnDeadline = keep || Date.now() + TURN_MS;
  room.turnKey = room.evSeq;
  room.turnTimer = setTimeout(auto('medium', true), Math.max(0, room.turnDeadline - Date.now()));
}
function isPaused(room) { return room.status !== 'lobby' && humans(room).some(x => !x.connected); }
function maybeContinue(room) {
  if (room.status !== 'dealEnd' && room.status !== 'over') return;
  if (isPaused(room)) { broadcast(room); return; }
  const need = humans(room);
  if (!need.length) return;
  if (need.every(x => room.ready.has(x.id))) {
    if (room.status === 'over') startSeries(room); else startDeal(room, false);
  } else broadcast(room);
}

// ---------- Повідомлення від гравців ----------
function sameCards(a, b) { return a.length === b.length && a.every(c => b.includes(c)); }
function handle(ws, user, m) {
  const code = userRoom.get(user.id), room = code && rooms.get(code);
  switch (m.t) {
    case 'create': {
      leaveRoom(user.id);
      const n = [2, 3, 4].includes(m.n) ? m.n : 2;
      const nr = createRoom(user, n, m.level);
      broadcast(nr); sendChatHistory(nr, user.id);
      return;
    }
    case 'join': {
      const r = joinRoom(user, String(m.code || '').replace(/\D/g, ''));
      if (typeof r === 'string') return send(ws, { t: 'error', msg: r });
      broadcast(r); sendChatHistory(r, user.id); schedule(r); maybeContinue(r);
      return;
    }
    case 'leave': { const c = userRoom.get(user.id); leaveRoom(user.id); send(ws, { t: 'left', lastRoom: lastRoomFor(user.id) }); return; }
  }
  if (!room) return send(ws, { t: 'error', msg: 'Ви не за столом.' });
  const s = seatOf(room, user.id), isHost = room.hostId === user.id;
  switch (m.t) {
    case 'seat': // пересісти на вільне місце (лише в лобі)
      if (room.status === 'lobby' && room.seats[m.i] === null) { room.seats[m.i] = room.seats[s]; room.seats[s] = null; broadcast(room); }
      return;
    case 'bot':
      if (isHost && room.status === 'lobby' && room.seats[m.i] === null) {
        room.seats[m.i] = { type: 'bot', level: room.level, name: botName(room) }; broadcast(room);
      }
      return;
    case 'unbot':
      if (isHost && room.status === 'lobby' && room.seats[m.i] && room.seats[m.i].type === 'bot') { room.seats[m.i] = null; broadcast(room); }
      return;
    case 'level':
      if (isHost && room.status === 'lobby' && AI.LEVELS[m.level]) {
        room.level = m.level; for (const x of room.seats) if (x && x.type === 'bot') x.level = m.level; broadcast(room);
      }
      return;
    case 'start':
      if (isHost && room.status === 'lobby' && room.seats.every(Boolean)) startSeries(room);
      return;
    case 'act': {
      if (room.status === 'playing' && isPaused(room)) return send(ws, { t: 'error', msg: 'Гру зупинено: чекаємо, поки гравець повернеться.' });
      if (room.status !== 'playing' || E.toAct(room.deal) !== s) return send(ws, { t: 'error', msg: 'Зараз не ваш хід.' });
      const a = m.a || {};
      const legal = E.legalActions(room.deal).find(x => x.type === a.type && (!x.cards || (Array.isArray(a.cards) && sameCards(x.cards, a.cards))));
      if (!legal) return send(ws, { t: 'error', msg: 'Такий хід неможливий.' });
      doAction(room, s, legal);
      return;
    }
    case 'ready':
      room.ready.add(user.id); maybeContinue(room);
      return;
    case 'chat': {
      if (s < 0) return;
      const err = postChat(room, user, m.text);
      if (err) send(ws, { t: 'error', msg: err });
      return;
    }
    case 'replace': { // господар садить бота замість гравця, який не повертається
      const x = room.seats[m.i];
      if (!isHost || room.status === 'lobby' || !x || x.type !== 'human' || x.connected) return;
      userRoom.delete(x.id); userLast.delete(x.id); room.ready.delete(x.id);
      room.seats[m.i] = { type: 'bot', level: room.level, name: botName(room) };
      broadcast(room); schedule(room); maybeContinue(room);
      return;
    }
  }
}

const wss = new WebSocketServer({ server, path: '/ws' });
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
      sockets.set(user.id, ws);
      send(ws, { t: 'welcome', me: user, lastRoom: userRoom.has(user.id) ? null : lastRoomFor(user.id) });
      const code = userRoom.get(user.id), room = code && rooms.get(code);
      if (room) {
        const s = seatOf(room, user.id);
        if (s >= 0) { room.seats[s].connected = true; room.seats[s].left = false; room.emptySince = null; }
        broadcast(room); sendChatHistory(room, user.id); schedule(room); maybeContinue(room);
      }
      if (m.join) {
        const r = joinRoom(user, String(m.join).replace(/\D/g, ''));
        if (typeof r === 'string') send(ws, { t: 'error', msg: r }); else { broadcast(r); sendChatHistory(r, user.id); schedule(r); maybeContinue(r); }
      }
      return;
    }
    try { handle(ws, user, m); } catch (e) { console.error(e); send(ws, { t: 'error', msg: 'Помилка сервера.' }); }
  });
  ws.on('close', () => {
    if (!user || sockets.get(user.id) !== ws) return;
    sockets.delete(user.id);
    const code = userRoom.get(user.id), room = code && rooms.get(code);
    if (!room) return;
    const s = seatOf(room, user.id);
    if (s < 0) return;
    if (room.status === 'lobby') { leaveRoom(user.id); return; }
    room.seats[s].connected = false;
    if (!humans(room).some(x => x.connected)) room.emptySince = Date.now();
    broadcast(room); schedule(room);
  });
});

// Перевірка зв'язку та прибирання покинутих столів
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
  for (const [code, room] of rooms) {
    if (room.emptySince && Date.now() - room.emptySince > 15 * 60 * 1000) {
      clearTimeout(room.timer); clearTimeout(room.turnTimer);
      for (const x of humans(room)) { if (userRoom.get(x.id) === code) userRoom.delete(x.id); if (userLast.get(x.id) === code) userLast.delete(x.id); }
      rooms.delete(code);
    }
  }
}, 25000);

server.listen(PORT, () => console.log('Боярський козел слухає порт ' + PORT + (ALLOW_GUESTS ? ' (гості дозволені)' : '')));
