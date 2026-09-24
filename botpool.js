// ===== Боярський козел: боти думають у фоновому потоці =====
// Поки бот рахує хід, сервер і далі відповідає всім столам (раніше «Дядя Слава» підвішував сервер на ~1 с).
const { Worker, isMainThread, parentPort } = require('worker_threads');
const E = require('./engine.js');
const AI = require('./ai.js');

if (!isMainThread) {
  parentPort.on('message', ({ id, state, level, seed }) => {
    let a = null, err = null;
    try { a = AI.chooseAction(E.unpackState(state), level, E.mulberry32(seed)); } catch (e) { err = e.message; }
    parentPort.postMessage({ id, a, err });
  });
} else {
  const os = require('os');
  const SIZE = Math.max(1, Math.min(2, (os.cpus() || []).length));
  const workers = [], waiting = new Map(), queue = [];
  let nextId = 1;

  function spawn() {
    const w = new Worker(__filename);
    w.busy = null;
    w.on('message', ({ id, a, err }) => {
      const job = waiting.get(id); waiting.delete(id); w.busy = null;
      if (job) err ? job.reject(new Error(err)) : job.resolve(a);
      pump();
    });
    w.on('error', e => {
      console.log('bot worker: ' + e.message);
      const job = w.busy && waiting.get(w.busy);
      if (job) { waiting.delete(w.busy); job.reject(e); }
      workers.splice(workers.indexOf(w), 1);
      workers.push(spawn());
      pump();
    });
    w.unref();
    return w;
  }
  function pump() {
    for (const w of workers) {
      if (w.busy || !queue.length) continue;
      const job = queue.shift();
      w.busy = job.id; waiting.set(job.id, job);
      w.postMessage({ id: job.id, state: job.state, level: job.level, seed: job.seed });
    }
  }
  let ready = false;
  function init() {
    if (ready) return;
    ready = true;
    for (let i = 0; i < SIZE; i++) workers.push(spawn());
  }

  // Повертає Promise з ходом бота. Якщо потоки недоступні — рахуємо на місці.
  module.exports = {
    choose(state, level, rng) {
      const seed = (rng() * 4294967296) >>> 0;
      try { init(); } catch (e) { ready = false; }
      if (!workers.length) return Promise.resolve(AI.chooseAction(state, level, E.mulberry32(seed)));
      return new Promise((resolve, reject) => {
        queue.push({ id: nextId++, state: E.packState(state), level, seed, resolve, reject });
        pump();
      }).catch(e => {
        console.log('bot worker fallback: ' + e.message);
        return AI.chooseAction(state, level, E.mulberry32(seed));
      });
    },
  };
}
