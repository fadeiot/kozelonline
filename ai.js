// ===== Боярський козел: штучний суперник (2, 3 або 4 гравці) =====
// Легкий: евристика з шумом. Середній/Сильний: Монте-Карло з детермінізацією —
// бот "вгадує" приховані карти лише з того, що бачив сам, і розігрує варіанти до кінця роздачі.
const E = (typeof module !== 'undefined') ? require('./engine.js') : Engine;

const trumpStrength = (c, trump) => E.suitOf(c) === trump ? 10 + E.rankOf(c) : 0;
const keepValue = (c, trump) => E.ptsOf(c) + trumpStrength(c, trump) * 0.9 + E.rankOf(c) * 0.25;

// Ваги евристики (їх підібрано турнірами ботів; див. tune.js)
// W0 — старі ваги (до вересня 2026), W1 — підібрані турніром: у грі «евристика проти евристики» вигравали 64% роздач проти 34%.
// Головні відмінності: охочіше ходить кількома картами одразу і сміливо виводить старші карти, вище за які в масті вже нічого не лишилось.
const W0 = { aN: 2.2, aPts: 0.55, aTr: 7, aRank: 0.3, aEnd: 6, aSafe: 0, gT: 2, gD: 2, gOwn: 1, bias: 4, cTr: 0.8, cRank: 0.2, later: 0.7, kPts: 1, kTr: 0.9, kRank: 0.25 };
const W1 = { aN: 10.57, aPts: 0.55, aTr: 7, aRank: 0.3, aEnd: 6, aSafe: 0.71, gT: 2, gD: 2, gOwn: 0.97, bias: 3.88, cTr: 0.896, cRank: 0.2, later: 0.7, kPts: 1, kTr: 0.9, kRank: 0.183 };
let W = { ...W1 };
// Карти, яких гравець p не бачив (у чужих руках, у колоді або скинуті сорочкою)
function unseenFor(s, p) {
  const seen = new Set(s.hands[p]);
  for (const pile of s.piles) for (const e of pile) if (!e.hidden || e.by === p) seen.add(e.c);
  if (s.table) { for (const c of s.table.attack) seen.add(c); for (const l of s.table.layers) if (l.type === 'cover' || l.p === p) for (const c of l.cards) seen.add(c); }
  if (s.stock.length && s.stock[s.stock.length - 1] === s.trumpCard) seen.add(s.trumpCard);
  const out = [];
  for (let c = 0; c < 36; c++) if (!seen.has(c)) out.push(c);
  return out;
}
function heuristicAction(s, rng, noise, w) {
  w = w || W;
  const acts = E.legalActions(s);
  const trump = s.trump;
  const kv = c => E.ptsOf(c) * w.kPts + trumpStrength(c, trump) * w.kTr + E.rankOf(c) * w.kRank;
  if (s.phase === 'attack') {
    let best = null, bs = -1e9;
    const endgame = s.stock.length === 0;
    let uns = null, unsTr = 0;
    if (w.aSafe) { uns = unseenFor(s, E.toAct(s)); unsTr = uns.filter(c => E.suitOf(c) === trump).length; }
    for (const a of acts) {
      const n = a.cards.length;
      const pts = a.cards.reduce((t, c) => t + E.ptsOf(c), 0);
      const tr = a.cards.filter(c => E.suitOf(c) === trump).length;
      let sc = n * w.aN - pts * w.aPts - tr * w.aTr - a.cards.reduce((t, c) => t + E.rankOf(c), 0) * w.aRank;
      if (endgame) sc += a.cards.filter(c => E.rankOf(c) === 8 || (E.suitOf(c) === trump && E.rankOf(c) >= 6)).length * w.aEnd;
      if (w.aSafe) {
        // «безпечні» старші карти: вище за них у масті вже нічого не лишилось
        for (const c of a.cards) {
          const su = E.suitOf(c), hi = uns.some(u => E.suitOf(u) === su && E.rankOf(u) > E.rankOf(c));
          if (!hi) sc += w.aSafe * E.ptsOf(c) * (su === trump ? 1 : Math.max(0, 1 - unsTr / 6));
        }
      }
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
      const cost = a.cards.reduce((x, c) => x + trumpStrength(c, trump) * w.cTr + E.rankOf(c) * w.cRank, 0);
      if (cost < bc) { bc = cost; bestCover = a; }
    } else if (a.type === 'discard') {
      const cost = a.cards.reduce((x, c) => x + kv(c), 0);
      if (cost < bd) { bd = cost; bestDisc = a; }
    }
  }
  const discPts = bestDisc ? bestDisc.cards.reduce((x, c) => x + E.ptsOf(c), 0) : 0;
  if (bestCover) {
    let gain = tablePts * w.gT + discPts * w.gD + bestCover.cards.reduce((x, c) => x + E.ptsOf(c), 0) * w.gOwn;
    if (laterDefenders > 0) gain *= w.later; // мене ще можуть перебити
    if (gain + w.bias + (rng() - 0.5) * noise > bc) return bestCover;
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

function utility(s, p, wPts) {
  const wp = wPts === undefined ? 0.004 : wPts;
  const r = E.dealResult(s, 1);
  const n = s.n;
  if (n === 4) {
    const t = p % 2;
    return -r.pens[t] + r.pens[1 - t] + (r.teamPts[t] - r.teamPts[1 - t]) * wp;
  }
  let others = 0, optsSum = 0;
  for (let q = 0; q < n; q++) if (q !== p) { others += r.pens[q]; optsSum += r.pts[q]; }
  const w = n === 2 ? 1 : 0.5;
  return -r.pens[p] + w * others / (n - 1) + (r.pts[p] - optsSum / (n - 1)) * wp;
}

function rollout(s, rng, noise, w) {
  let guard = 0;
  while (s.phase !== 'dealEnd') {
    if (s.phase === 'resolve') E.finishTrick(s);
    else E.applyAction(s, heuristicAction(s, rng, noise, w));
    if (++guard > 800) throw new Error('rollout loop');
  }
}

const LEVELS = {
  easy: { mc: 0, noise: 6 },
  medium: { mc: 60, noise: 3 },
  hard: { mc: 400, noise: 2, timeMs: 700, w: W0 }, // колишній «Сильний» — лишився лише для порівняння в турнірах
  // «Дядя Слава» — єдиний рівень у грі. Посередині роздачі — Монте-Карло, а коли колода скінчилася,
  // він точно прораховує всі ходи до кінця роздачі для кожного правдоподібного розкладу карт.
  slava: { mc: 400, noise: 2, timeMs: 800, endgame: true, endDet: 40, endNodes: 60000 },
};

// ---------- Точний розрахунок кінцівки (колода скінчилася, гра на двох) ----------
// Для кожного правдоподібного розкладу карт бот перебирає всі ходи до кінця роздачі (мінімакс з відсіканням),
// а не покладається на випадкові розіграші. Саме в кінцівці вирішується доля тузів і десяток.
function endKey(s) {
  const t = s.table;
  return s.phase + '|' + s.attacker + '|' + s.hands.map(h => h.slice().sort((a, b) => a - b).join(',')).join('/') + '|' +
    (t ? t.attack.join(',') + ':' + t.by + ':' + t.top.join(',') + ':' + t.topBy + ':' + t.layers.map(l => l.p + l.type[0] + l.cards.join(',')).join(';') + ':' + t.queue.join(',') + ':' + (t.intercepted ? 1 : 0) : '') +
    '|' + (s.combo3 ? s.combo3.map(x => x ? 1 : 0).join('') : '') + '|' + s.piles.map(pl => pl.reduce((x, e) => x + E.ptsOf(e.c), 0)).join(',');
}
function solverActions(s) {
  let acts = E.legalActions(s);
  // скидання: досить трьох найдешевших варіантів
  const disc = acts.filter(a => a.type === 'discard');
  if (disc.length > 3) {
    const cost = a => a.cards.reduce((x, c) => x + keepValue(c, s.trump), 0);
    const keep = new Set(disc.slice().sort((a, b) => cost(a) - cost(b)).slice(0, 3));
    acts = acts.filter(a => a.type !== 'discard' || keep.has(a));
  }
  return acts;
}
function solveEnd(s, me, alpha, beta, memo, budget) {
  while (s.phase === 'resolve') E.finishTrick(s);
  if (s.phase === 'dealEnd') return utility(s, me, 0.01);
  if (--budget.left < 0) throw budget;
  const key = endKey(s);
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const q = E.toAct(s), maxing = q === me || (s.n === 4 && q % 2 === me % 2); // партнер грає за нас
  let best = maxing ? -1e9 : 1e9;
  for (const a of solverActions(s)) {
    const c = E.cloneState(s);
    E.applyAction(c, a);
    const v = solveEnd(c, me, alpha, beta, memo, budget);
    if (maxing) { if (v > best) best = v; if (best > alpha) alpha = best; }
    else { if (v < best) best = v; if (best < beta) beta = best; }
    if (alpha >= beta) return best; // відсікання: неточне значення не кешуємо
  }
  memo.set(key, best);
  return best;
}
function chooseEndgame(s, acts, cfg, rng) {
  const p = E.toAct(s), sums = new Array(acts.length).fill(0), t0 = Date.now();
  let done = 0;
  const maxDet = cfg.endDet || 40;
  for (let it = 0; it < maxDet; it++) {
    const det = determinize(s, p, rng);
    const memo = new Map(), budget = { left: (cfg.endNodes || 60000) / (s.n === 2 ? 1 : 3) };
    const vals = [];
    try {
      for (const a of acts) { const c = E.cloneState(det); E.applyAction(c, a); vals.push(solveEnd(c, p, -1e9, 1e9, memo, budget)); }
    } catch (e) { if (e !== budget) throw e; return null; } // задовго — хай вирішує звичайний спосіб
    vals.forEach((v, i) => { sums[i] += v; });
    done++;
    if (Date.now() - t0 > (cfg.timeMs || 800) && done >= (s.n === 2 ? 8 : 4)) break;
  }
  if (!done) return null;
  let bi = 0;
  for (let i = 1; i < acts.length; i++) if (sums[i] > sums[bi]) bi = i;
  return acts[bi];
}

// Відкидаємо явно слабкі варіанти скидання: лишаємо k найдешевших (решта рідко краща, а ділить бюджет обчислень)
function pruneActions(s, acts, k) {
  const trump = s.trump;
  const disc = acts.filter(a => a.type === 'discard');
  if (disc.length <= k) return acts;
  const cost = a => a.cards.reduce((x, c) => x + keepValue(c, trump), 0);
  const keep = new Set(disc.slice().sort((a, b) => cost(a) - cost(b)).slice(0, k));
  return acts.filter(a => a.type !== 'discard' || keep.has(a));
}
function chooseAction(s, level, rng) {
  const cfg = typeof level === 'object' ? level : (LEVELS[level] || LEVELS.hard);
  let acts = E.legalActions(s);
  if (acts.length === 1) return acts[0];
  if (!cfg.mc) return heuristicAction(s, rng, cfg.noise);
  if (cfg.prune) acts = pruneActions(s, acts, cfg.prune);
  if (cfg.endgame && s.stock.length === 0) {
    const ea = chooseEndgame(s, acts, cfg, rng);
    if (ea) return ea;
  }
  const p = E.toAct(s);
  const sums = new Array(acts.length).fill(0);
  const t0 = Date.now();
  for (let it = 0; it < cfg.mc; it++) {
    const det = cfg.cheat ? E.cloneState(s) : determinize(s, p, rng); // cheat — лише для перевірок сили, у грі не використовується
    const seed = (rng() * 4294967296) >>> 0;
    for (let i = 0; i < acts.length; i++) {
      const sim = E.cloneState(det);
      E.applyAction(sim, acts[i]);
      rollout(sim, E.mulberry32(seed), cfg.rnoise || 1.5, cfg.w);
      sums[i] += utility(sim, p, cfg.wPts);
    }
    if (cfg.timeMs && Date.now() - t0 > cfg.timeMs && it >= 60) break;
  }
  let bi = 0;
  for (let i = 1; i < acts.length; i++) if (sums[i] > sums[bi]) bi = i;
  return acts[bi];
}

const AI = { heuristicAction, determinize, chooseAction, utility, LEVELS, W0, W1, setWeights: w => { W = { ...W0, ...w }; } };
if (typeof module !== 'undefined') module.exports = AI;
