// Генерация новых блюд через Gemini и вставка в БД.
// Запуск: npm run generate -- --category breakfast --count 25
// Категории: breakfast, lunch, dinner, snack. Ключ: GEMINI_API_KEY в .env.
require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./guidefit.db');

const catArg = process.argv.indexOf('--category');
const countArg = process.argv.indexOf('--count');
const category = catArg > -1 ? process.argv[catArg + 1] : 'breakfast';
const count = countArg > -1 ? parseInt(process.argv[countArg + 1]) : 25;

const GOALS = { breakfast: ['lose','maintain'], lunch: ['lose','gain','maintain'], dinner: ['lose','maintain'], snack: ['lose','gain'] };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function generate() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) { console.error('Нет GEMINI_API_KEY в .env'); process.exit(1); }
  const prompt = `Сгенерируй ровно ${count} разных реальных блюд категории "${category}" (русская кухня и интернациональная).
Ответь СТРОГО одним JSON-массивом без пояснений, формат:
[{"name":"Название","ingredients":[{"name":"Куриное филе","amount":200,"unit":"г"}],"calories":450,"protein":35,"fat":12,"carbs":40,"steps":["шаг 1","шаг 2","шаг 3"]}]
Требования: названия без кавычек внутри, 4-7 ингредиентов, 3-6 шагов, адекватные КБЖУ (калории числом, белки/жиры/углеводы в граммах).`;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  if (!res.ok) { console.error('Gemini HTTP', res.status, await res.text()); process.exit(1); }
  const data = await res.json();
  const text = data.candidates && data.candidates[0] && data.candidates[0].content.parts[0].text;
  if (!text) { console.error('Пустой ответ Gemini'); process.exit(1); }
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) { console.error('Gemini не вернул JSON:', text.slice(0, 300)); process.exit(1); }
  return JSON.parse(jsonMatch[0]);
}

(async () => {
  const maxId = await new Promise((res, rej) =>
    db.get("SELECT COALESCE(MAX(id), 0) m FROM recipes", [], (e, r) => e ? rej(e) : res(r.m)));
  console.log(`Генерация: ${count} блюд, категория ${category}, стартовый id ${maxId + 1}`);
  const dishes = await generate();
  let id = maxId;
  const stmt = db.prepare(`INSERT OR IGNORE INTO recipes
    (id, title, category, calories, protein, fat, carbs, description, benefits, ingredients, recipe_steps, image_url, goals)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`);
  dishes.forEach(d => {
    if (!d.name || !Array.isArray(d.ingredients) || !Array.isArray(d.steps)) return;
    stmt.run(++id, d.name, category, d.calories || 0, d.protein || 0, d.fat || 0, d.carbs || 0,
      '', '', JSON.stringify(d.ingredients), JSON.stringify(d.steps), JSON.stringify(GOALS[category] || ['maintain']));
    console.log('Добавлено:', d.name);
  });
  stmt.finalize();
  await sleep(500);
  console.log('DONE');
  process.exit(0);
})();
