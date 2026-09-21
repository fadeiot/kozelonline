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
const BOT_USERNAME = (process.env.BOT_USERNAME || '').replace(/^@/, '');
const APP_NAME = process.env.APP_NAME || '';
const ALLOW_GUESTS = !BOT_TOKEN || process.env.ALLOW_GUESTS === '1';

// На безкоштовному сервері процесор слабкий: сильний бот думає не довше 400 мс
AI.LEVELS.hard.timeMs = 400;
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
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (url.pathname === '/' || url.pathname === '/index.html') return serveIndex(res);
  res.writeHead(404); res.end('not found');
});

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
    return { id: 'tg' + u.id, name: name.slice(0, 24) };
  } catch (e) { return null; }
}

// ---------- Столи ----------
const rooms = new Map();          // код → стіл
const userRoom = new Map();       // id гравця → код столу
const sockets = new Map();        // id гравця → WebSocket
const BOT_NAMES = ['Кум', 'Сват', 'Брат', 'Дядько'];
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = ''; for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)];
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
  };
  room.seats[0] = { type: 'human', id: user.id, name: user.name, connected: true };
  rooms.set(room.code, room); userRoom.set(user.id, room.code);
  return room;
}
function seatOf(room, id) { return room.seats.findIndex(x => x && x.type === 'human' && x.id === id); }

function joinRoom(user, code) {
  const room = rooms.get(code);
  if (!room) return 'Стіл не знайдено. Перевірте код.';
  const cur = seatOf(room, user.id);
  if (cur >= 0) { Object.assign(room.seats[cur], { connected: true, left: false, name: user.name }); room.emptySince = null; userRoom.set(user.id, code); return room; }
  if (room.status !== 'lobby') return 'Гра за цим столом уже йде.';
  const free = room.seats.findIndex(x => x === null);
  if (free < 0) return 'Усі місця зайняті.';
  leaveRoom(user.id);
  room.seats[free] = { type: 'human', id: user.id, name: user.name, connected: true };
  userRoom.set(user.id, code);
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
  if (room.status === 'lobby') room.seats[s] = null;
  else { room.seats[s].connected = false; room.seats[s].left = true; }
  if (room.hostId === id) { const h = humans(room).find(x => x.connected && !x.left); if (h) room.hostId = h.id; }
  if (!humans(room).some(x => x.connected)) room.emptySince = Date.now();
  if (room.status === 'lobby' && !humans(room).length) { rooms.delete(code); return; }
  broadcast(room);
  if (room.status === 'playing') schedule(room);
  else if (room.status !== 'lobby') maybeContinue(room);
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
    seats: room.seats.map((x, i) => x && { name: x.name, bot: x.type === 'bot', connected: x.type === 'bot' || x.connected, me: x.type === 'human' && x.id === id, host: x.type === 'human' && x.id === room.hostId }),
    names: room.seats.map((_, r) => { const x = room.seats[unrot(r)]; return x ? x.name : ''; }),
    online: room.seats.map((_, r) => { const x = room.seats[unrot(r)]; return !x || x.type === 'bot' || x.connected; }),
    ready: [...room.ready].map(uid => seatOf(room, uid)).filter(i => i >= 0).map(rot),
    waiting: humans(room).filter(x => x.connected && !x.left && !room.ready.has(x.id)).map(x => x.id === id ? 'ви' : x.name),
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
function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room) {
  for (const x of humans(room)) if (x.connected) send(sockets.get(x.id), viewFor(room, x.id));
}

// ---------- Хід гри ----------
function startSeries(room) {
  room.ser = E.newSeries(room.n); room.result = null; room.rec = null;
  startDeal(room, true);
}
function startDeal(room, first) {
  room.deal = E.newDeal(rng, room.n, first, room.ser.nextStarter);
  room.status = 'playing'; room.result = null; room.rec = null; room.ready = new Set();
  room.ev = { t: 'deal', p: room.deal.attacker }; room.evSeq++;
  broadcast(room); schedule(room);
}
function endDeal(room) {
  const res = E.dealResult(room.deal, room.ser.mult);
  const rec = E.applyDealToSeries(room.ser, res, room.deal.lastTrick);
  room.result = res; room.rec = rec; room.ready = new Set();
  room.status = room.ser.over ? 'over' : 'dealEnd';
}
function doAction(room, p, a) {
  clearTimeout(room.turnTimer);
  E.applyAction(room.deal, a);
  room.ev = { t: a.type, p, k: a.cards ? a.cards.length : 0 }; room.evSeq++;
  broadcast(room); schedule(room);
}
function schedule(room) {
  clearTimeout(room.timer); clearTimeout(room.turnTimer);
  if (room.status !== 'playing') return;
  const d = room.deal;
  if (d.phase === 'resolve') {
    room.timer = setTimeout(() => {
      const w = E.finishTrick(d);
      room.ev = { t: 'collected', p: w }; room.evSeq++;
      if (d.phase === 'dealEnd') endDeal(room);
      broadcast(room); schedule(room);
    }, 1500);
    return;
  }
  if (d.phase === 'dealEnd') return;
  const p = E.toAct(d), seat = room.seats[p];
  const auto = level => () => { if (room.deal === d && E.toAct(d) === p) doAction(room, p, AI.chooseAction(d, level, rng)); };
  if (seat.type === 'bot') room.timer = setTimeout(auto(seat.level), 650);
  else if (!seat.connected) room.timer = setTimeout(auto('medium'), seat.left ? 1500 : 30000); // нема зв'язку: хід за гравця
  else room.turnTimer = setTimeout(auto('easy'), 120000); // гравець задрімав
}
function maybeContinue(room) {
  if (room.status !== 'dealEnd' && room.status !== 'over') return;
  const need = humans(room).filter(x => x.connected && !x.left);
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
      broadcast(createRoom(user, n, m.level));
      return;
    }
    case 'join': {
      const r = joinRoom(user, String(m.code || '').toUpperCase().trim());
      if (typeof r === 'string') return send(ws, { t: 'error', msg: r });
      broadcast(r); if (r.status === 'playing') schedule(r);
      return;
    }
    case 'leave': leaveRoom(user.id); send(ws, { t: 'left' }); return;
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
      send(ws, { t: 'welcome', me: user });
      const code = userRoom.get(user.id), room = code && rooms.get(code);
      if (room) {
        const s = seatOf(room, user.id);
        if (s >= 0) { room.seats[s].connected = true; room.seats[s].left = false; room.emptySince = null; }
        broadcast(room); if (room.status === 'playing') schedule(room);
      }
      if (m.join) {
        const r = joinRoom(user, String(m.join).toUpperCase());
        if (typeof r === 'string') send(ws, { t: 'error', msg: r }); else { broadcast(r); if (r.status === 'playing') schedule(r); }
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
    broadcast(room); schedule(room); maybeContinue(room);
  });
});

// Перевірка зв'язку та прибирання покинутих столів
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
  for (const [code, room] of rooms) {
    if (room.emptySince && Date.now() - room.emptySince > 15 * 60 * 1000) {
      clearTimeout(room.timer); clearTimeout(room.turnTimer);
      for (const x of humans(room)) if (userRoom.get(x.id) === code) userRoom.delete(x.id);
      rooms.delete(code);
    }
  }
}, 25000);

server.listen(PORT, () => console.log('Боярський козел слухає порт ' + PORT + (ALLOW_GUESTS ? ' (гості дозволені)' : '')));
