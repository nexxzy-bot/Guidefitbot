// Прогрев кеша фото: проходит по рецептам без фото, качает URL с Pexels, пишет в БД.
// Pexels: 200 запросов/час => 1 запрос каждые 19 секунд. Запускайте повторно, пока не напишет DONE.
// Ctrl+C безопасен: всё, что скачано, уже в БД.
require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./guidefit.db');

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? parseInt(process.argv[limitArg + 1]) : 99999;
const SLEEP_MS = 19000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPexels(query) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) { console.error('Нет PEXELS_API_KEY в .env'); process.exit(1); }
  const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=square`, {
    headers: { 'Authorization': key }
  });
  if (!res.ok) { console.error('Pexels HTTP', res.status); return null; }
  const data = await res.json();
  return (data.photos && data.photos[0]) ? (data.photos[0].src.medium || data.photos[0].src.small) : null;
}

(async () => {
  const rows = await new Promise((res, rej) =>
    db.all("SELECT id, title FROM recipes WHERE image_url IS NULL OR image_url = '' OR image_url = 'empty.jpg' LIMIT ?",
      [LIMIT], (e, r) => e ? rej(e) : res(r)));
  if (!rows.length) { console.log('DONE: все рецепты уже с фото'); process.exit(0); }
  console.log(`Осталось обработать: ${rows.length}. Пауза между запросами: ${SLEEP_MS / 1000} с`);
  let done = 0;
  for (const row of rows) {
    const url = await fetchPexels(row.title + ' food dish meal');
    if (url) {
      await new Promise((res, rej) => db.run("UPDATE recipes SET image_url = ? WHERE id = ?", [url, row.id], e => e ? rej(e) : res()));
      console.log(`[${++done}/${rows.length}] ${row.title} -> OK`);
    } else {
      console.log(`[${++done}/${rows.length}] ${row.title} -> не найдено, пропуск`);
    }
    await sleep(SLEEP_MS);
  }
  console.log('DONE: пачка обработана. Запустите снова для следующей порции.');
  process.exit(0);
})();
