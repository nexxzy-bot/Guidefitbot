// Локальные фото блюд: качает файл с Pexels, жмёт в WebP 800px q80 через sharp,
// кладёт в static/images/dishes/dish_<id>.webp, в БД пишет локальный путь.
// Pexels Search API: 200 запросов/час => пауза 19с ТОЛЬКО после обращения к API.
// Повторный запуск безопасен: существующие файлы пропускаются без запросов к API.
// Флаги: --limit N (первые N), --force (перекачать даже существующие).
// Ctrl+C безопасен: всё обработанное уже записано.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const sharp = require('sharp');

const db = new sqlite3.Database('./guidefit.db');
db.configure('busyTimeout', 15000);

const DIR = path.join(__dirname, '..', 'static', 'images', 'dishes');
const SLEEP_MS = 19000;

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? parseInt(process.argv[limitArg + 1]) : 99999;
const FORCE = process.argv.includes('--force');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function dbAll(sql, args) {
  return new Promise((res, rej) => db.all(sql, args, (e, r) => e ? rej(e) : res(r || [])));
}
function dbRun(sql, args) {
  return new Promise((res, rej) => db.run(sql, args, e => e ? rej(e) : res()));
}
function localName(id) { return `dish_${id}.webp`; }
function localPublic(id) { return `/images/dishes/${localName(id)}`; }

async function fetchPexels(query) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) throw new Error('Нет PEXELS_API_KEY в .env');
  const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=square`, {
    headers: { 'Authorization': key },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`Pexels HTTP ${res.status}`);
  const data = await res.json();
  return (data.photos && data.photos[0]) ? (data.photos[0].src.large || data.photos[0].src.medium) : null;
}

async function downloadBuffer(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Download HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const rows = await dbAll(
    "SELECT id, title, image_url FROM recipes ORDER BY id LIMIT ?", [LIMIT]);
  if (!rows.length) { console.log('DONE: рецептов нет'); process.exit(0); }
  console.log(`Всего к обработке: ${rows.length}${FORCE ? ' (force: перекачать всё)' : ''}`);

  let ok = 0, skipped = 0, failed = 0;
  for (const [i, row] of rows.entries()) {
    const tag = `[${i + 1}/${rows.length}] #${row.id} ${row.title}`;
    try {
      const dest = path.join(DIR, localName(row.id));
      if (!FORCE && fs.existsSync(dest)) {
        if (row.image_url !== localPublic(row.id)) {
          await dbRun("UPDATE recipes SET image_url = ? WHERE id = ?", [localPublic(row.id), row.id]);
        }
        skipped++;
        console.log(`${tag} -> уже есть, пропуск`);
        continue;
      }
      let src = (row.image_url && /^https?:\/\//.test(row.image_url)) ? row.image_url : null;
      let usedApi = false;
      if (!src) {
        src = await fetchPexels(row.title + ' food dish meal');
        usedApi = true;
        if (!src) { failed++; console.log(`${tag} -> Pexels ничего не нашёл, пропуск`); continue; }
      }
      const buf = await downloadBuffer(src);
      await sharp(buf)
        .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(dest + '.tmp');
      fs.renameSync(dest + '.tmp', dest);
      await dbRun("UPDATE recipes SET image_url = ? WHERE id = ?", [localPublic(row.id), row.id]);
      ok++;
      console.log(`${tag} -> OK ${localPublic(row.id)}`);
      if (usedApi) await sleep(SLEEP_MS);
    } catch (e) {
      failed++;
      console.log(`${tag} -> ОШИБКА: ${e.message}`);
      try { fs.unlinkSync(path.join(DIR, localName(row.id) + '.tmp')); } catch (_) {}
    }
  }
  console.log('------------------------------');
  console.log(`ИТОГ: успешно ${ok}, пропущено ${skipped}, ошибок ${failed}, всего ${rows.length}`);
  process.exit(0);
})().catch(e => { console.error('Фатальная ошибка:', e.message); process.exit(1); });
