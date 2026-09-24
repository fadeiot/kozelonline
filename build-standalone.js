// Збирає автономну версію гри одним файлом (для перегляду без сервера, напр. як артефакт у Claude):
// правила, боти й статистика вбудовуються в сторінку, музика — як data-URI, скрипт Telegram прибирається.
//   node build-standalone.js  →  dist/kozel-standalone.html
const fs = require('fs');
const path = require('path');
const dir = __dirname;
let html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
for (const name of ['engine.js', 'ai.js', 'stats.js']) {
  const tag = `<script src="${name}"></script>`;
  if (!html.includes(tag)) throw new Error('Не знайдено ' + tag);
  const code = fs.readFileSync(path.join(dir, name), 'utf8');
  html = html.replace(tag, () => '<script>\n' + code + '\n</script>');
}
html = html.replace('<script src="https://telegram.org/js/telegram-web-app.js"></script>\n', '');
const music = path.join(dir, 'music.m4a');
if (fs.existsSync(music)) {
  const b64 = fs.readFileSync(music).toString('base64');
  html = html.replace("const MUSIC_SRC = 'music.m4a';", () => `const MUSIC_SRC = 'data:audio/mp4;base64,${b64}';`);
}
fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
fs.writeFileSync(path.join(dir, 'dist', 'kozel-standalone.html'), html);
console.log('dist/kozel-standalone.html: ' + Math.round(html.length / 1024) + ' КБ');
