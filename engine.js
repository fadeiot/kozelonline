// ===== Боярський козел: рушій гри (2, 3 або 4 гравці) =====
// Єдине джерело правил: цей файл підключає і сервер (require), і сторінка гри (<script src>).
// Карта = число 0..35: масть = c/9|0, ранг = c%9
// Порядок старшинства (ранг 0..8): 6 7 8 9 В Д К 10 Т
const SUIT_SYM = ['♠', '♣', '♥', '♦'];
const SUIT_NAME = ['піки', 'трефи', 'чирва', 'бубни'];
const RANK_LABEL = ['6', '7', '8', '9', 'В', 'Д', 'К', '10', 'Т'];
const PTS = [0, 0, 0, 0, 2, 3, 4, 10, 11];
const suitOf = c => (c / 9) | 0;
const rankOf = c => c % 9;
const ptsOf = c => PTS[c % 9];
const cardLabel = c => RANK_LABEL[rankOf(c)] + SUIT_SYM[suitOf(c)];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

function beats(d, a, trump) {
  const sd = suitOf(d), sa = suitOf(a);
  if (sd === sa) return rankOf(d) > rankOf(a);
  return sd === trump;
}
// Пари: res[i] — карта, що б'є att[i]; null, якщо так побити не можна
function matchCover(att, def, trump) {
  if (att.length !== def.length) return null;
  const used = new Array(def.length).fill(false), res = [];
  const rec = i => {
    if (i === att.length) return true;
    for (let j = 0; j < def.length; j++) {
      if (!used[j] && beats(def[j], att[i], trump)) {
        used[j] = true; res[i] = def[j];
        if (rec(i + 1)) return true;
        used[j] = false;
      }
    }
    return false;
  };
  return rec(0) ? res : null;
}
const canCover = (att, def, trump) => matchCover(att, def, trump) !== null;
function isUniform(cards) {
  if (cards.length <= 1) return true;
  const s = suitOf(cards[0]), r = rankOf(cards[0]);
  return cards.every(c => suitOf(c) === s) || cards.every(c => rankOf(c) === r);
}
function isCombo(hand) { return hand.length === 4 && isUniform(hand); }
// «Хід без черги»: 4 однакові карти (масть чи номінал). Особливий випадок: колода скінчилася на останньому доборі
// і гравцю дісталося лише 3 карти — тоді 3 однакові теж дають право перехопити (2 — ні).
function comboOf(s, p) {
  const h = s.hands[p];
  if (h.length === 4) return isUniform(h);
  return h.length === 3 && !!(s.combo3 && s.combo3[p]) && isUniform(h);
}
function subsets(arr) {
  const out = [], n = arr.length;
  for (let m = 1; m < (1 << n); m++) {
    const s = [];
    for (let i = 0; i < n; i++) if (m & (1 << i)) s.push(arr[i]);
    out.push(s);
  }
  return out;
}
function subsetsOfSize(arr, k) { return subsets(arr).filter(s => s.length === k); }

// Пара на пару: команди 0-2 та 1-3
const teamOf = (n, p) => n === 4 ? p % 2 : p;
const teamCount = n => n === 4 ? 2 : n;

// Захисники по черзі (за годинниковою стрілкою від атакуючого)
function defendersFrom(n, p) { const r = []; for (let i = 1; i < n; i++) r.push((p + i) % n); return r; }

// ---------- Роздача ----------
function newDeal(rng, n, firstDeal, starter) {
  const deck = shuffle([...Array(36).keys()], rng);
  const hands = Array.from({ length: n }, () => []);
  for (let r = 0; r < 4; r++) for (let p = 0; p < n; p++) hands[p].push(deck.pop());
  const stock = deck; // stock[0] — верх, stock[last] — козир, що світить
  let trumpCard = stock[stock.length - 1], trump = suitOf(trumpCard), trumpChanges = 0;
  let attacker = starter;
  if (firstDeal) {
    for (;;) {
      let best = null, bestP = -1;
      for (let p = 0; p < n; p++) for (const c of hands[p])
        if (suitOf(c) === trump && (best === null || rankOf(c) < rankOf(best))) { best = c; bestP = p; }
      if (bestP >= 0) { attacker = bestP; break; }
      shuffle(stock, rng);
      trumpCard = stock[stock.length - 1]; trump = suitOf(trumpCard); trumpChanges++;
    }
  }
  return {
    n, trump, trumpCard, stock, hands,
    piles: Array.from({ length: n }, () => []), // {c, hidden, by}
    attacker, phase: 'attack', table: null, lastTrick: null, trumpHolder: null,
    known: Array.from({ length: n }, () => new Map()),     // карта -> власник (у чужій руці), відомо гравцю p
    knownHidden: Array.from({ length: n }, () => new Set()), // закриті карти, які p знає
    trumpChanges,
    combo3: new Array(n).fill(false), // хто лишився з 3 картами після останнього добору
  };
}

function cloneTable(t) {
  if (!t) return null;
  return {
    attack: t.attack.slice(), by: t.by, top: t.top.slice(), topBy: t.topBy,
    layers: t.layers.map(l => ({ p: l.p, type: l.type, cards: l.cards.slice() })),
    queue: t.queue.slice(), interceptQueue: t.interceptQueue.slice(),
    intercepted: t.intercepted, attackerWasCombo: t.attackerWasCombo,
  };
}
function cloneState(s) {
  return {
    n: s.n, trump: s.trump, trumpCard: s.trumpCard, stock: s.stock.slice(),
    hands: s.hands.map(h => h.slice()),
    piles: s.piles.map(pl => pl.map(e => ({ c: e.c, hidden: e.hidden, by: e.by }))),
    attacker: s.attacker, phase: s.phase, table: cloneTable(s.table),
    lastTrick: s.lastTrick, trumpHolder: s.trumpHolder,
    known: s.known.map(m => new Map(m)), knownHidden: s.knownHidden.map(x => new Set(x)),
    trumpChanges: s.trumpChanges, combo3: s.combo3 ? s.combo3.slice() : null,
  };
}

function toAct(s) {
  if (s.phase === 'attack') return s.attacker;
  if (s.phase === 'intercept') return s.table.interceptQueue[0];
  if (s.phase === 'defend') return s.table.queue[0];
  return -1; // 'resolve' або 'dealEnd'
}

// У грі на двох перехоплення — одна з дій захисника
function canIntercept(s) {
  if (s.n !== 2 || s.phase !== 'defend' || s.table.intercepted || s.table.attackerWasCombo) return false;
  if (s.table.layers.length) return false;
  return comboOf(s, toAct(s));
}

function legalActions(s) {
  const p = toAct(s);
  if (p < 0) return [];
  const hand = s.hands[p];
  const acts = [];
  if (s.phase === 'attack') {
    for (const sub of subsets(hand)) if (isUniform(sub)) acts.push({ type: 'attack', cards: sub });
    return acts;
  }
  if (s.phase === 'intercept') return [{ type: 'intercept' }, { type: 'pass' }];
  const top = s.table.top;
  if (canIntercept(s)) acts.push({ type: 'intercept' });
  const subs = subsetsOfSize(hand, top.length);
  for (const sub of subs) if (canCover(top, sub, s.trump)) acts.push({ type: 'cover', cards: sub });
  for (const sub of subs) acts.push({ type: 'discard', cards: sub });
  return acts;
}

function removeCards(hand, cards) {
  for (const c of cards) {
    const i = hand.indexOf(c);
    if (i < 0) throw new Error('Карти ' + cardLabel(c) + ' немає в руці');
    hand.splice(i, 1);
  }
}
function forgetPlayed(s, cards) { for (const m of s.known) for (const c of cards) m.delete(c); }

function startDefense(s) {
  const t = s.table;
  t.queue = defendersFrom(s.n, t.by);
  s.phase = 'defend';
}

function applyAction(s, a) {
  const p = toAct(s);
  if (p < 0) throw new Error('Зараз ніхто не ходить');
  if (a.type === 'attack') {
    if (s.phase !== 'attack') throw new Error('Зараз не атака');
    if (!a.cards.length || !isUniform(a.cards)) throw new Error('Неприпустимий хід');
    const wasCombo = comboOf(s, p);
    removeCards(s.hands[p], a.cards); if (s.combo3) s.combo3[p] = false;
    forgetPlayed(s, a.cards);
    s.table = { attack: a.cards.slice(), by: p, top: a.cards.slice(), topBy: null, layers: [],
      queue: [], interceptQueue: [], intercepted: false, attackerWasCombo: wasCombo };
    if (s.n > 2 && !wasCombo) {
      const elig = defendersFrom(s.n, p).filter(q => comboOf(s, q));
      if (elig.length) { s.table.interceptQueue = elig; s.phase = 'intercept'; return; }
    }
    startDefense(s);
    return;
  }
  if (a.type === 'pass') {
    if (s.phase !== 'intercept') throw new Error('Нема чого пропускати');
    s.table.interceptQueue.shift();
    if (!s.table.interceptQueue.length) startDefense(s);
    return;
  }
  if (a.type === 'intercept') {
    if (!(s.phase === 'intercept' || canIntercept(s))) throw new Error('Перехоплення неможливе');
    const t = s.table, back = t.attack;
    s.hands[t.by].push(...back); if (s.combo3) s.combo3[t.by] = false;
    for (let q = 0; q < s.n; q++) if (q !== t.by) for (const c of back) s.known[q].set(c, t.by);
    const combo = s.hands[p].slice();
    s.hands[p] = []; if (s.combo3) s.combo3[p] = false;
    forgetPlayed(s, combo);
    s.table = { attack: combo, by: p, top: combo.slice(), topBy: null, layers: [],
      queue: [], interceptQueue: [], intercepted: true, attackerWasCombo: true, returned: back.slice(), returnedTo: t.by };
    s.attacker = p;
    startDefense(s);
    return;
  }
  if (s.phase !== 'defend') throw new Error('Зараз не захист');
  const t = s.table;
  if (a.cards.length !== t.top.length) throw new Error('Потрібно ' + t.top.length + ' карт');
  if (a.type === 'cover') {
    const m = matchCover(t.top, a.cards, s.trump);
    if (!m) throw new Error('Цими картами не побити');
    removeCards(s.hands[p], a.cards); if (s.combo3) s.combo3[p] = false;
    forgetPlayed(s, a.cards);
    t.layers.push({ p, type: 'cover', cards: m });
    t.top = m; t.topBy = p;
  } else if (a.type === 'discard') {
    removeCards(s.hands[p], a.cards); if (s.combo3) s.combo3[p] = false;
    for (let q = 0; q < s.n; q++) for (const c of a.cards)
      if (s.known[q].has(c)) { s.known[q].delete(c); s.knownHidden[q].add(c); }
    t.layers.push({ p, type: 'discard', cards: a.cards.slice() });
  } else throw new Error('Невідома дія');
  t.queue.shift();
  if (!t.queue.length) s.phase = 'resolve';
}

// Хто забирає взятку, що лежить на столі
function trickWinner(s) { const t = s.table; return t.topBy === null ? t.by : t.topBy; }

function finishTrick(s) {
  if (s.phase !== 'resolve') throw new Error('Взятка ще не зіграна');
  const t = s.table, w = trickWinner(s);
  for (const c of t.attack) s.piles[w].push({ c, hidden: false, by: t.by });
  for (const l of t.layers) for (const c of l.cards) s.piles[w].push({ c, hidden: l.type === 'discard', by: l.p });
  s.table = null; s.lastTrick = w; s.attacker = w;
  // добір: першим той, хто взяв взятку, далі за годинниковою стрілкою
  let q = w;
  const hadStock = s.stock.length > 0;
  while (s.stock.length && s.hands.some(h => h.length < 4)) {
    if (s.hands[q].length < 4) {
      const c = s.stock.shift();
      s.hands[q].push(c);
      if (c === s.trumpCard) { s.trumpHolder = q; for (let o = 0; o < s.n; o++) if (o !== q) s.known[o].set(c, q); }
    }
    q = (q + 1) % s.n;
  }
  // колода скінчилася саме на цьому доборі: хто лишився з 3 картами, отримує право на «хід без черги» трьома
  if (hadStock && !s.stock.length) s.combo3 = s.hands.map(h => h.length === 3);
  s.phase = (!s.stock.length && s.hands.every(h => !h.length)) ? 'dealEnd' : 'attack';
  return w;
}

function pilePoints(s, p) { return s.piles[p].reduce((t, e) => t + ptsOf(e.c), 0); }
const penaltyFor = pts => pts === 0 ? 4 : pts <= 30 ? 2 : 1;

// Результат роздачі. pens[i] — штрафні очки гравця i за цю роздачу
function dealResult(s, mult) {
  const n = s.n, pts = s.piles.map((_, i) => pilePoints(s, i));
  const pens = new Array(n).fill(0);
  if (n === 2 || n === 4) {
    // на двох — гравці, пара на пару — команди; правила однакові
    const tp = n === 2 ? pts.slice() : [pts[0] + pts[2], pts[1] + pts[3]];
    const tpens = [0, 0];
    if (tp[0] === 60) return { pts, teamPts: tp, eggs: true, pens: tpens, winners: [], bases: [0, 0] };
    const loser = tp[0] < tp[1] ? 0 : 1;
    const bases = [0, 0]; bases[loser] = penaltyFor(tp[loser]);
    tpens[loser] = bases[loser] * mult;
    return { pts, teamPts: tp, eggs: false, pens: tpens, bases, winners: [1 - loser], loser, penalty: tpens[loser], base: bases[loser] };
  }
  // На трьох: перемагає найбільша сума (нічия за перше — обидва без штрафу), решта за шкалою
  const max = Math.max(...pts);
  const bases = pts.map(x => x === max ? 0 : penaltyFor(x));
  for (let i = 0; i < n; i++) pens[i] = bases[i] * mult;
  return { pts, eggs: false, pens, bases, winners: pts.map((x, i) => x === max ? i : -1).filter(i => i >= 0) };
}

// ---------- Серія ----------
function newSeries(n, goal) {
  return { n, goal: goal === 6 ? 6 : 12, penalties: new Array(teamCount(n)).fill(0), mult: 1, dealNo: 0, nextStarter: null,
    over: false, loser: -1, losers: [], milk: false, deals: [] };
}
function applyDealToSeries(ser, res, lastTrick) {
  ser.dealNo++;
  // наступну роздачу починає гравець, що сидить після того, хто взяв останню взятку (за годинниковою стрілкою)
  ser.nextStarter = lastTrick === null || lastTrick === undefined ? null : (lastTrick + 1) % ser.n;
  const rec = { pts: res.pts, eggs: res.eggs, mult: ser.mult, pens: res.pens.slice(), bases: res.bases };
  ser.deals.push(rec);
  if (res.eggs) { ser.mult *= 2; return rec; }
  for (let i = 0; i < ser.penalties.length; i++) ser.penalties[i] += res.pens[i];
  ser.mult = 1;
  const P = ser.penalties, max = Math.max(...P), min = Math.min(...P);
  const withMax = P.map((x, i) => x === max ? i : -1).filter(i => i >= 0);
  if (ser.n === 2 || ser.n === 4) {
    if ((P[0] === 6 && P[1] === 0) || (P[1] === 6 && P[0] === 0)) { ser.over = true; ser.milk = true; }
    else if (max >= ser.goal) ser.over = true;
  } else {
    if (max >= 6 && min === 0) { ser.over = true; ser.milk = true; }
    else if (max >= ser.goal) ser.over = true;
  }
  if (ser.over) { ser.losers = withMax; ser.loser = withMax[0]; }
  return rec;
}

// Стан роздачі у вигляді простого JSON (для збереження, фонового потоку ботів, CloudStorage)
function packState(s) {
  return { ...s, table: cloneTable(s.table), known: s.known.map(m => [...m]), knownHidden: s.knownHidden.map(x => [...x]) };
}
function unpackState(o) {
  return { ...o, known: o.known.map(a => new Map(a)), knownHidden: o.knownHidden.map(a => new Set(a)) };
}

const Engine = {
  SUIT_SYM, SUIT_NAME, RANK_LABEL, PTS, suitOf, rankOf, ptsOf, cardLabel,
  mulberry32, shuffle, beats, canCover, matchCover, isUniform, isCombo, comboOf, subsets, subsetsOfSize,
  defendersFrom, teamOf, teamCount, newDeal, cloneState, toAct, legalActions, canIntercept, applyAction, trickWinner,
  finishTrick, pilePoints, penaltyFor, dealResult, newSeries, applyDealToSeries, packState, unpackState,
};
if (typeof module !== 'undefined') module.exports = Engine;
