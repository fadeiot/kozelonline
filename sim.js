// Турнір ботів на двох: чи справді сильніший рівень виграє частіше?
//   node sim.js [рівень1] [рівень2] [кількість роздач]
//   напр.: node sim.js medium hard 60
// Кожна пара роздач грається двічі з тими самими картами, помінявши гравців місцями (щоб прибрати везіння).
const E = require('./engine.js');
const AI = require('./ai.js');
const [a = 'easy', b = 'medium', nArg = '40'] = process.argv.slice(2);
const N = +nArg;
const levels = [a, b];
let pens = [0, 0], pts = [0, 0], dealsWon = [0, 0];
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const seed = 1000 + i;
  for (const swap of [false, true]) {
    const rng = E.mulberry32(seed);
    const s = E.newDeal(rng, 2, true, 0);
    const lv = swap ? [b, a] : [a, b];
    const brng = E.mulberry32(seed * 7 + (swap ? 1 : 0));
    while (s.phase !== 'dealEnd') {
      if (s.phase === 'resolve') { E.finishTrick(s); continue; }
      const p = E.toAct(s);
      E.applyAction(s, AI.chooseAction(s, lv[p], brng));
    }
    const r = E.dealResult(s, 1);
    for (let p = 0; p < 2; p++) {
      const who = swap ? 1 - p : p; // індекс рівня
      pens[who] += r.pens[p]; pts[who] += r.pts[p];
      if (!r.eggs && r.loser !== p) dealsWon[who]++;
    }
  }
  if ((i + 1) % 10 === 0) process.stdout.write(`${i + 1}/${N}… `);
}
const D = N * 2;
console.log(`\n${levels[0]} проти ${levels[1]}, роздач: ${D}, час: ${Math.round((Date.now() - t0) / 1000)} с`);
for (let k = 0; k < 2; k++)
  console.log(`  ${levels[k].padEnd(7)} виграв роздач: ${(100 * dealsWon[k] / D).toFixed(1)}%, очок у середньому: ${(pts[k] / D).toFixed(1)}, штрафних на роздачу: ${(pens[k] / D).toFixed(2)}`);
