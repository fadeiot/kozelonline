// ===== Боярський козел: штучний суперник (2 або 3 гравці) =====
// Легкий: евристика з шумом. Середній/Сильний: Монте-Карло з детермінізацією —
// бот "вгадує" приховані карти лише з того, що бачив сам, і розігрує варіанти до кінця роздачі.
const E = (typeof module !== 'undefined') ? require('./engine.js') : Engine;

const trumpStrength = (c, trump) => E.suitOf(c) === trump ? 10 + E.rankOf(c) : 0;
const keepValue = (c, trump) => E.ptsOf(c) + trumpStrength(c, trump) * 0.9 + E.rankOf(c) * 0.25;

function heuristicAction(s, rng, noise) {
  const acts = E.legalActions(s);
  const trump = s.trump;
  if (s.phase === 'attack') {
    let best = null, bs = -1e9;
    const endgame = s.stock.length === 0;
    for (const a of acts) {
      const n = a.cards.length;
      const pts = a.cards.reduce((t, c) => t + E.ptsOf(c), 0);
      const tr = a.cards.filter(c => E.suitOf(c) === trump).length;
      let sc = n * 2.2 - pts * 0.55 - tr * 7 - a.cards.reduce((t, c) => t + E.rankOf(c), 0) * 0.3;
      if (endgame) sc += a.cards.filter(c => E.rankOf(c) === 8 || (E.suitOf(c) === trump && E.rankOf(c) >= 6)).length * 6;
      sc += (rng() - 0.5) * noise;
      if (sc > bs) { bs = sc; best = a; }
    }
    return best;
  }
  const me = E.toAct(s), t = s.table;
  const mate = q => s.n === 4 && q !== me && q % 2 === me % 2;
  if (s.phase === 'intercept') return mate(t.by) ? acts[1] : (rng() < 0.97 ? acts[0] : acts[1]);
  const inter = acts.find(a => a.type === 'intercept');
  if (inter && rng() > noise * 0.02) return inter;
  const owner = t.topBy === null ? t.by : t.topBy;
  if (mate(owner)) {
    // старші карти в партнера: не перебиваємо; якщо суперників після мене нема — "підмазуємо" дорогими
    const oppAfter = t.queue.slice(1).some(q => q % 2 !== me % 2);
    let best = null, bv = -1e9;
    for (const a of acts) if (a.type === 'discard') {
      const pts = a.cards.reduce((x, c) => x + E.ptsOf(c), 0);
      const keep = a.cards.reduce((x, c) => x + trumpStrength(c, trump) * 0.9 + E.rankOf(c) * 0.25, 0);
      const v = (oppAfter ? -pts * 0.6 : pts * 1.0) - keep + (rng() - 0.5) * noise;
      if (v > bv) { bv = v; best = a; }
    }
    if (best) return best;
  }
  let tablePts = t.attack.reduce((x, c) => x + E.ptsOf(c), 0);
  for (const l of t.layers) if (l.type === 'cover') tablePts += l.cards.reduce((x, c) => x + E.ptsOf(c), 0);
  const laterDefenders = t.queue.length - 1; // хто ще битиме після мене
  let bestCover = null, bc = 1e9, bestDisc = null, bd = 1e9;
  for (const a of acts) {
    if (a.type === 'cover') {
      const cost = a.cards.reduce((x, c) => x + trumpStrength(c, trump) * 0.8 + E.rankOf(c) * 0.2, 0);
      if (cost < bc) { bc = cost; bestCover = a; }
    } else if (a.type === 'discard') {
      const cost = a.cards.reduce((x, c) => x + keepValue(c, trump), 0);
      if (cost < bd) { bd = cost; bestDisc = a; }
    }
  }
  const discPts = bestDisc ? bestDisc.cards.reduce((x, c) => x + E.ptsOf(c), 0) : 0;
  if (bestCover) {
    let gain = tablePts * 2 + discPts * 2 + bestCover.cards.reduce((x, c) => x + E.ptsOf(c), 0);
    if (laterDefenders > 0) gain *= 0.7; // мене ще можуть перебити
    if (gain + 4 + (rng() - 0.5) * noise > bc) return bestCover;
  }
  return bestDisc;
}

// Випадковий розклад прихованих карт, сумісний з тим, що знає гравець p
function determinize(s, p, rng) {
  const d = E.cloneState(s);
  const excluded = new Set(s.hands[p]);
  for (const pile of s.piles) for (const e of pile) if (!e.hidden || e.by === p) excluded.add(e.c);
  if (s.table) {
    for (const c of s.table.attack) excluded.add(c);
    for (const l of s.table.layers) if (l.type === 'cover' || l.p === p) for (const c of l.cards) excluded.add(c);
  }
  for (const c of s.knownHidden[p]) excluded.add(c);
  const knownIn = Array.from({ length: s.n }, () => []);
  for (const [c, owner] of s.known[p]) if (s.hands[owner].includes(c)) { knownIn[owner].push(c); excluded.add(c); }
  const trumpInStock = s.stock.length > 0 && s.stock[s.stock.length - 1] === s.trumpCard;
  if (trumpInStock) excluded.add(s.trumpCard);

  const pool = [];
  for (let c = 0; c < 36; c++) if (!excluded.has(c)) pool.push(c);
  E.shuffle(pool, rng);
  let k = 0;
  for (let q = 0; q < s.n; q++) {
    if (q === p) continue;
    const h = knownIn[q].slice();
    while (h.length < s.hands[q].length) h.push(pool[k++]);
    d.hands[q] = h;
  }
  const stock = [];
  const free = trumpInStock ? s.stock.length - 1 : s.stock.length;
  for (let i = 0; i < free; i++) stock.push(pool[k++]);
  if (trumpInStock) stock.push(s.trumpCard);
  d.stock = stock;
  const unknownHidden = c => !s.knownHidden[p].has(c);
  for (const pile of d.piles) for (const e of pile)
    if (e.hidden && e.by !== p && unknownHidden(e.c)) e.c = pool[k++];
  if (d.table) for (const l of d.table.layers)
    if (l.type === 'discard' && l.p !== p) l.cards = l.cards.map(c => unknownHidden(c) ? pool[k++] : c);
  if (k !== pool.length) throw new Error('determinize: pool mismatch ' + k + ' vs ' + pool.length);
  return d;
}

function utility(s, p) {
  const r = E.dealResult(s, 1);
  const n = s.n;
  if (n === 4) {
    const t = p % 2;
    return -r.pens[t] + r.pens[1 - t] + (r.teamPts[t] - r.teamPts[1 - t]) * 0.004;
  }
  let others = 0, optsSum = 0;
  for (let q = 0; q < n; q++) if (q !== p) { others += r.pens[q]; optsSum += r.pts[q]; }
  const w = n === 2 ? 1 : 0.5;
  return -r.pens[p] + w * others / (n - 1) + (r.pts[p] - optsSum / (n - 1)) * 0.004;
}

function rollout(s, rng, noise) {
  let guard = 0;
  while (s.phase !== 'dealEnd') {
    if (s.phase === 'resolve') E.finishTrick(s);
    else E.applyAction(s, heuristicAction(s, rng, noise));
    if (++guard > 800) throw new Error('rollout loop');
  }
}

const LEVELS = {
  easy: { mc: 0, noise: 6 },
  medium: { mc: 60, noise: 3 },
  hard: { mc: 400, noise: 2, timeMs: 700 },
  // «Дядя Слава» — єдиний рівень у грі. Турнір ботів показав, що більше часу на роздуми сили не додає, тож думає до 0,8 с
  slava: { mc: 400, noise: 2, timeMs: 800 },
};

function chooseAction(s, level, rng) {
  const cfg = LEVELS[level] || LEVELS.hard;
  const acts = E.legalActions(s);
  if (acts.length === 1) return acts[0];
  if (!cfg.mc) return heuristicAction(s, rng, cfg.noise);
  const p = E.toAct(s);
  const sums = new Array(acts.length).fill(0);
  const t0 = Date.now();
  for (let it = 0; it < cfg.mc; it++) {
    const det = determinize(s, p, rng);
    const seed = (rng() * 4294967296) >>> 0;
    for (let i = 0; i < acts.length; i++) {
      const sim = E.cloneState(det);
      E.applyAction(sim, acts[i]);
      rollout(sim, E.mulberry32(seed), cfg.rnoise || 1.5);
      sums[i] += utility(sim, p);
    }
    if (cfg.timeMs && Date.now() - t0 > cfg.timeMs && it >= 60) break;
  }
  let bi = 0;
  for (let i = 1; i < acts.length; i++) if (sums[i] > sums[bi]) bi = i;
  return acts[bi];
}

const AI = { heuristicAction, determinize, chooseAction, utility, LEVELS };
if (typeof module !== 'undefined') module.exports = AI;
