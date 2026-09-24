// ===== Боярський козел: статистика і нагороди =====
// Спільний файл для сервера (онлайн-статистика) і сторінки гри (статистика ігор з ботами).
const ACH = [
  { id: 'first_win', icon: '🏆', name: 'Перша перемога', desc: 'Виграти першу партію' },
  { id: 'milk', icon: '🥛', name: 'Молочник', desc: 'Виграти 6:0 — зробити когось молочним козлом' },
  { id: 'interceptor', icon: '🤚', name: 'Перехоплювач', desc: 'Перехопити хід 5 разів' },
  { id: 'dry', icon: '🍞', name: 'Сухар', desc: 'Залишити суперника без жодного очка в роздачі' },
  { id: 'eggs', icon: '🥚', name: 'Яєчник', desc: 'Зіграти «яйця» — 60 на 60' },
  { id: 'streak3', icon: '🔥', name: 'Нездоланний', desc: 'Виграти 3 партії поспіль' },
  { id: 'veteran', icon: '🎖', name: 'Ветеран', desc: 'Зіграти 25 партій' },
  { id: 'old_goat', icon: '🐐', name: 'Старий козел', desc: 'Стати козлом 10 разів (буває)' },
];
const ACH_RULE = {
  first_win: s => s.wins >= 1,
  milk: s => s.milkWins >= 1,
  interceptor: s => s.intercepts >= 5,
  dry: s => s.dry >= 1,
  eggs: s => s.eggs >= 1,
  streak3: s => s.bestStreak >= 3,
  veteran: s => s.games >= 25,
  old_goat: s => s.goats >= 10,
};

function blank(name) {
  return { name: name || '', games: 0, wins: 0, goats: 0, milkGoats: 0, milkWins: 0, deals: 0, dealsWon: 0,
    eggs: 0, intercepts: 0, dry: 0, streak: 0, bestStreak: 0, ach: {}, friends: {}, last: 0 };
}
// Нові нагороди, які щойно відкрито (і позначаємо їх відкритими)
function checkAch(s, now) {
  const got = [];
  for (const a of ACH) if (!s.ach[a.id] && ACH_RULE[a.id](s)) { s.ach[a.id] = now || Date.now(); got.push(a.id); }
  return got;
}
function onIntercept(s) { s.intercepts++; return checkAch(s); }
// d = { won, eggs, dry }
function onDeal(s, d) {
  s.deals++;
  if (d.won) s.dealsWon++;
  if (d.eggs) s.eggs++;
  if (d.dry) s.dry++;
  s.last = Date.now();
  return checkAch(s);
}
// g = { lost, milk }
function onSeries(s, g) {
  s.games++;
  if (g.lost) { s.goats++; if (g.milk) s.milkGoats++; s.streak = 0; }
  else { s.wins++; if (g.milk) s.milkWins++; s.streak++; s.bestStreak = Math.max(s.bestStreak, s.streak); }
  return checkAch(s);
}

// Що означає роздача для гравця (або його команди) p. res — результат E.dealResult, n — кількість гравців.
function dealFacts(res, n, p) {
  if (res.eggs) return { won: false, eggs: true, dry: false };
  if (n === 3) {
    const won = res.pens[p] === 0;
    return { won, eggs: false, dry: won && res.pts.some((x, i) => i !== p && x === 0) };
  }
  const t = n === 4 ? p % 2 : p;
  const won = res.loser !== t;
  const oppPts = res.teamPts[1 - t];
  return { won, eggs: false, dry: won && oppPts === 0 };
}
// Чи програв партію гравець p (серія вже закінчена)
function seriesLost(ser, p) {
  return ser.n === 4 ? ser.loser === p % 2 : ser.losers.includes(p);
}

const Stats = { ACH, blank, checkAch, onIntercept, onDeal, onSeries, dealFacts, seriesLost };
if (typeof module !== 'undefined') module.exports = Stats;
