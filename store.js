// ===== Боярський козел: сховище (столи й статистика переживають перезапуск сервера) =====
// Якщо задано UPSTASH_REDIS_REST_URL і UPSTASH_REDIS_REST_TOKEN — пишемо в Upstash Redis (безкоштовний план).
// Інакше — у файл data/store.json поруч із сервером (на Render безкоштовному цей файл зникає при перезапуску,
// тому для справжнього збереження потрібен Redis).
const fs = require('fs');
const path = require('path');

const URL_ = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const PREFIX = process.env.STORE_PREFIX || 'kozel:';
const FILE = path.join(__dirname, 'data', 'store.json');

let fileData = null;
function loadFile() {
  if (fileData) return fileData;
  try { fileData = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { fileData = {}; }
  return fileData;
}
let fileTimer = null;
function saveFileSoon() {
  clearTimeout(fileTimer);
  fileTimer = setTimeout(saveFileNow, 300);
}
function saveFileNow() {
  clearTimeout(fileTimer);
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(fileData || {}));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (e) { console.log('store: не вдалося записати файл: ' + e.message); }
}

async function redis(cmd) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

const Store = {
  kind: URL_ && TOKEN ? 'redis' : 'file',
  async get(key) {
    try {
      if (this.kind === 'redis') {
        const v = await redis(['GET', PREFIX + key]);
        return v == null ? null : JSON.parse(v);
      }
      const d = loadFile();
      return d[key] === undefined ? null : d[key];
    } catch (e) { console.log('store.get ' + key + ': ' + e.message); return null; }
  },
  async set(key, value) {
    try {
      if (this.kind === 'redis') { await redis(['SET', PREFIX + key, JSON.stringify(value)]); return true; }
      loadFile()[key] = value; saveFileSoon(); return true;
    } catch (e) { console.log('store.set ' + key + ': ' + e.message); return false; }
  },
  flushFile() { if (this.kind === 'file' && fileData) saveFileNow(); },
};
module.exports = Store;
