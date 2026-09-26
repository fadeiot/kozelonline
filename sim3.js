// На трьох: один бот з налаштуванням B проти двох з налаштуванням A, місце B міняється по колу.
const E = require('./engine.js'), AI = require('./ai.js');
const [A, B] = [JSON.parse(process.argv[2]), JSON.parse(process.argv[3])], N = +(process.argv[4] || 40);
let penA = 0, penB = 0, cA = 0, cB = 0;
for (let i = 0; i < N; i++) for (let seat = 0; seat < 3; seat++) {
  const rng = E.mulberry32(9000 + i), s = E.newDeal(rng, 3, true, 0), brng = E.mulberry32(i * 31 + seat);
  while (s.phase !== 'dealEnd') { if (s.phase === 'resolve') { E.finishTrick(s); continue; } const p = E.toAct(s); E.applyAction(s, AI.chooseAction(s, p === seat ? B : A, brng)); }
  const r = E.dealResult(s, 1);
  for (let p = 0; p < 3; p++) if (p === seat) { penB += r.pens[p]; cB++; } else { penA += r.pens[p]; cA++; }
}
console.log(JSON.stringify({ deals: N * 3, penA: +(penA / cA).toFixed(3), penB: +(penB / cB).toFixed(3) }));
