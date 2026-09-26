// Порівняння двох налаштувань ботів на двох (дзеркальні роздачі):  node sim2.js '{"mc":120}' '{"mc":120,"wPts":0.02}' 80
const E = require('./engine.js'), AI = require('./ai.js');
const [A, B] = [JSON.parse(process.argv[2]), JSON.parse(process.argv[3])];
const N = +(process.argv[4] || 60), off = +(process.argv[5] || 0);
let pens = [0, 0], won = [0, 0], D = 0;
for (let i = 0; i < N; i++) for (const swap of [false, true]) {
  const seed = 5000 + off + i, rng = E.mulberry32(seed);
  const s = E.newDeal(rng, 2, true, 0), lv = swap ? [B, A] : [A, B], brng = E.mulberry32(seed * 7 + swap);
  while (s.phase !== 'dealEnd') { if (s.phase === 'resolve') { E.finishTrick(s); continue; } E.applyAction(s, AI.chooseAction(s, lv[E.toAct(s)], brng)); }
  const r = E.dealResult(s, 1); D++;
  for (let p = 0; p < 2; p++) { const w = swap ? 1 - p : p; pens[w] += r.pens[p]; if (!r.eggs && r.loser !== p) won[w]++; }
}
console.log(JSON.stringify({ A, B, deals: D, winA: +(won[0] / D).toFixed(3), winB: +(won[1] / D).toFixed(3), penA: +(pens[0] / D).toFixed(3), penB: +(pens[1] / D).toFixed(3) }));
