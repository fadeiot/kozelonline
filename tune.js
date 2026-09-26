// Підбір ваг евристики: турнір «евристика проти евристики» на двох (швидко), дзеркальні роздачі.
//   node tune.js 1500 40      — 40 кандидатів по 1500 пар роздач
const E = require('./engine.js'), AI = require('./ai.js');
const N = +(process.argv[2] || 1000), K = +(process.argv[3] || 30), seedBase = +(process.argv[4] || 1);
function match(wA, wB, n, off) {
  let pA = 0, pB = 0;
  for (let i = 0; i < n; i++) for (const swap of [0, 1]) {
    const rng = E.mulberry32(77000 + off + i), s = E.newDeal(rng, 2, true, 0), br = E.mulberry32(i * 13 + swap);
    const ws = swap ? [wB, wA] : [wA, wB];
    while (s.phase !== 'dealEnd') { if (s.phase === 'resolve') { E.finishTrick(s); continue; } E.applyAction(s, AI.heuristicAction(s, br, 1, ws[E.toAct(s)])); }
    const r = E.dealResult(s, 1);
    if (swap) { pB += r.pens[0]; pA += r.pens[1]; } else { pA += r.pens[0]; pB += r.pens[1]; }
  }
  return (pA - pB) / (2 * n); // <0 — A кращий
}
const rnd = E.mulberry32(seedBase * 999);
let best = { ...AI.W0 }, bestScore = 0;
const keys = Object.keys(best);
for (let k = 0; k < K; k++) {
  const cand = { ...best };
  const m = 1 + Math.floor(rnd() * 3);
  for (let j = 0; j < m; j++) {
    const key = keys[Math.floor(rnd() * keys.length)];
    cand[key] = key === 'aSafe' && cand[key] === 0 ? 0.5 + rnd() : Math.max(0, cand[key] * (0.5 + rnd()));
  }
  const d = match(cand, best, N, k * 5000);
  if (d < -0.03) { best = cand; bestScore += d; console.log(`#${k} краще на ${(-d).toFixed(3)} штрафних/роздачу`, JSON.stringify(best)); }
}
console.log('BEST', JSON.stringify(best));
