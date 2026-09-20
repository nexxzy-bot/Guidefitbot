#!/usr/bin/env node
/* Импорт Unitools Recipes (CC BY-SA 4.0, github.com/farcrak/unitools-recipes)
   в нормализованную схему GuideFit: dishes / ingredients / dish_ingredients / dish_steps.

   Источник: data/unitools-recipes-v1.json (https://theunitools.com/data/unitools-recipes-v1.json).
   Язык: только русский. Датасет двуязычный (EN/RU, переведён вручную); рецепты с
   неполным русским переводом ДОПЕРЕВОДЯТСЯ локальным словарём (см. LEXICON).
   Если после этого поле всё ещё содержит латиницу — рецепт пропускается:
   в проде не остаётся ни одного нерусифицированного блюда/ингредиента/шага.

   Классификация на 4 приёма пищи (завтрак/обед/ужин/перекус):
     breakfast — явный breakfast из источника + 48 блюд с завтрак-ключами
                 (каша/омлет/сырники/блины/творог/гранола/панкейки...);
     snack     — sauce/drink + лёгкие snack (< 450 ккал) и salad (< 300 ккал);
     lunch     — основная трапеза: main/soup/bread/тяжёлые snack и salad;
     dinner    — main/soup не попавшие в lunch (чередование: индекс % 2),
                 средняя сытность, легче обеда за счёт подвыборки.
   Классификация детерминированная (порядок в JSON фиксирован) — повторный импорт даёт те же категории.

   Идемпотентность: dishes перезаливаются по id (DELETE + INSERT в транзакции);
   ingredients/dish_ingredients/dish_steps сносятся только для заливаемых блюд.
   Флаги: --dry (ничего не писать), --file <путь> (другой источник). */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
// db.js применяет схему (CREATE TABLE IF NOT EXISTS …) и отдаёт соединение с WAL/busy_timeout;
// очередь sqlite3 гарантирует, что DDL выполнится раньше наших INSERT-ов
const db = require('../db');

const fileArg = process.argv.indexOf('--file');
const SRC = fileArg > -1 ? process.argv[fileArg + 1] : path.join(__dirname, '..', 'data', 'unitools-recipes-v1.json');
const DRY = process.argv.includes('--dry');

/* Защита от случайного запуска на боевой базе.
   Скрипт легаси: он делает DELETE FROM recipes и пересобирает зеркало из датасета
   Unitools, то есть полностью подменяет прод-каталог (сейчас им владеет генератор
   scripts/gen-pp-dishes.js). Один запуск по невнимательности откатил бы каталог назад.
   Тесты не затрагиваются: они всегда передают свой временный DB_PATH.
   Осознанный запуск на бою: ALLOW_PROD_IMPORT=1 node scripts/import-unitools.js */
const PROD_DB = path.resolve(__dirname, '..', 'guidefit.db');
const TARGET_DB = path.resolve(process.env.DB_PATH || PROD_DB);
if (!DRY && TARGET_DB === PROD_DB && process.env.ALLOW_PROD_IMPORT !== '1') {
  console.error('Отказ: цель — боевая база (' + TARGET_DB + ').');
  console.error('Этот скрипт легаси: он очистит recipes и пересоберёт каталог из Unitools.');
  console.error('Тестам нужен отдельный DB_PATH; для осознанного запуска — ALLOW_PROD_IMPORT=1.');
  process.exit(1);
}

/* --- Локальный словарь для дозаполнения русского перевода (несколько плейсхолдеров в датасете) --- */
const LEXICON = {
  'salt': 'Соль', 'water': 'Вода', 'black pepper': 'Чёрный перец',
  'to taste': 'по вкусу', 'small piece': 'небольшой кусочек', 'small pieces': 'небольшие кусочки'
};

const ATTRIBUTION = 'Unitools Recipes (farcrak, github.com/farcrak/unitools-recipes), CC BY-SA 4.0';

/* --- Классификация --- */
const BREAKFAST_RE = /(каша|омлет|яичниц|сырник|блин|творог|гранола|мюсли|овсян|панкейк|оладь|шакшук|яйц)/i;
function classify(r, idx) {
  const cat = r.category || 'main';
  const kcal = (r.nutritionPerServing && r.nutritionPerServing.calories) || 0;
  const name = (r.name && r.name.ru) || '';
  const summary = (r.summary && r.summary.ru) || '';
  if (cat === 'breakfast') return 'breakfast';
  if (BREAKFAST_RE.test(name)) return 'breakfast';           // завтрак-ключи сильнее калорий
  if (cat === 'sauce' || cat === 'drink') return 'snack';
  if (cat === 'snack') return kcal < 450 ? 'snack' : 'lunch';
  if (cat === 'salad') return kcal < 300 ? 'snack' : 'lunch';
  if (cat === 'side') return kcal < 350 ? 'snack' : 'lunch';
  // main / soup / bread / dessert: делим сытные на обед и ужин через индекс (детерминированно);
  // десерты — чаще перекус
  if (cat === 'dessert') return idx % 3 === 0 ? 'lunch' : 'snack';
  return idx % 2 === 0 ? 'lunch' : 'dinner';
}

/* --- Русификация: латинские хвосты в ручном переводе --- */
const LATIN_WORD = /[A-Za-z]{3,}/;
function fixRu(s) {
  if (typeof s !== 'string') return s;
  let out = s.replace(/\b([A-Za-z][A-Za-z' -]{1,40}[a-z])\b/g, (m) => LEXICON[m.toLowerCase()] || m);
  return out;
}
function isRu(s) {
  return typeof s === 'string' && s.trim().length > 0 && !LATIN_WORD.test(s.replace(/[xX]\s*200|°C|°F/g, ''));
}

const unitRu = { piece: 'шт', g: 'г', kg: 'кг', ml: 'мл', l: 'л', tsp: 'ч. л.', tbsp: 'ст. л.',
  pinch: 'щепотка', toTaste: 'по вкусу', clove: 'зубчик', slice: 'ломтик', sprig: 'веточка' };

let stats = { total: 0, imported: 0, skippedLang: 0, skippedBad: 0, meal: { breakfast: 0, lunch: 0, dinner: 0, snack: 0 }, ings: 0, links: 0, steps: 0 };

function q(sql, args) {
  return new Promise((res, rej) => db.run(sql, args || [], function (e) { e ? rej(e) : res(this); }));
}
function get(sql, args) {
  return new Promise((res, rej) => db.get(sql, args || [], (e, r) => e ? rej(e) : res(r)));
}
function all(sql, args) {
  return new Promise((res, rej) => db.all(sql, args || [], (e, r) => e ? rej(e) : res(r)));
}
function fmtQty(v) {
  if (v === null || v === undefined) return null;
  const r = Math.round(Number(v) * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r);
}

(async () => {
  const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const data = raw.recipes || raw;
  stats.total = data.length;
  console.log('Источник: ' + SRC + ' (' + data.length + ' рецептов, ' + raw.license + ')');

  const ingCache = new Map(); // name -> id

  async function ingId(name) {
    if (ingCache.has(name)) return ingCache.get(name);
    const row = await get('SELECT id FROM ingredients WHERE name = ?', [name]);
    if (row) { ingCache.set(name, row.id); return row.id; }
    const r = await q('INSERT INTO ingredients (name) VALUES (?)', [name]);
    ingCache.set(name, r.lastID);
    stats.ings++;
    return r.lastID;
  }

  if (!DRY) await q('BEGIN');

  for (let i = 0; i < data.length; i++) {
    const r = data[i];
    const id = 20000 + i; // детерминированные id; пищевые дневники по старым id (1..400) не пересекаются
    const name = fixRu(r.name && r.name.ru);
    const summary = fixRu(r.summary && r.summary.ru);
    const meal = classify(r, i);

    // русификация ингредиентов
    let ings = [], badIng = false;
    for (const ing of (r.ingredients || [])) {
      let nm = fixRu(ing.name && ing.name.ru);
      if (!nm) { badIng = true; break; }
      ings.push({ nm, qty: ing.quantity, unit: unitRu[ing.unit] || ing.unit || '', scaling: ing.scaling || 'linear', note: fixRu(ing.note && ing.note.ru) || null });
    }
    // русификация шагов
    let steps = [], badStep = false;
    (r.steps || []).forEach((st, si) => {
      const tx = fixRu(st.text && st.text.ru);
      if (!tx) { badStep = true; return; }
      steps.push({ no: si + 1, text: tx, minutes: st.minutes || null });
    });

    // в прод не попадает ни один нерусифицированный текст
    const okLang = isRu(name) && steps.every(s => isRu(s.text)) && ings.every(x => isRu(x.nm));
    if (!okLang) { stats.skippedLang++; if (!DRY && r.slug) console.log('SKIP (нет RU): ' + r.slug); continue; }
    if (!name || badIng || !(r.nutritionPerServing)) { stats.skippedBad++; continue; }

    const n = r.nutritionPerServing;
    const photo = (r.photo && r.photo.url) || '';

    if (DRY) { stats.imported++; stats.meal[meal]++; stats.links += ings.length; stats.steps += steps.length; continue; }

    await q(`DELETE FROM dish_ingredients WHERE dish_id = ?`, [id]);
    await q(`DELETE FROM dish_steps WHERE dish_id = ?`, [id]);
    await q(`INSERT INTO dishes (id, slug, title, meal_type, calories, protein, fat, carbs,
              base_servings, prep_minutes, cook_minutes, description, category, country, difficulty, attribution, photo_url)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, title=excluded.title, meal_type=excluded.meal_type,
              calories=excluded.calories, protein=excluded.protein, fat=excluded.fat, carbs=excluded.carbs,
              base_servings=excluded.base_servings, prep_minutes=excluded.prep_minutes, cook_minutes=excluded.cook_minutes,
              description=excluded.description, category=excluded.category, country=excluded.country,
              difficulty=excluded.difficulty, attribution=excluded.attribution, photo_url=excluded.photo_url`,
      [id, r.slug || null, name, meal, n.calories || 0, n.protein || 0, n.fat || 0, n.carbs || 0,
       r.baseServings || 1, r.prepMinutes || null, r.cookMinutes || null, summary || null,
       r.category || null, r.country || null, r.difficulty || null, ATTRIBUTION, photo]);
    stats.imported++;
    stats.meal[meal]++;

    for (const x of ings) {
      const iid = await ingId(x.nm);
      await q(`INSERT INTO dish_ingredients (dish_id, ingredient_id, quantity, unit, scaling, note)
               VALUES (?, ?, ?, ?, ?, ?)`, [id, iid, x.qty === null ? null : Number(x.qty), x.unit, x.scaling, x.note]);
      stats.links++;
    }
    for (const s of steps) {
      await q('INSERT INTO dish_steps (dish_id, step_no, text, minutes) VALUES (?, ?, ?, ?)', [id, s.no, s.text, s.minutes]);
      stats.steps++;
    }
  }

  if (!DRY) {
    await q('COMMIT');
    // зеркало в legacy-таблицу recipes: весь существующий UI/дневник/список покупок работают без изменений
    const dishes = await all('SELECT * FROM dishes ORDER BY id');
    await q('DELETE FROM recipes');
    await q('DELETE FROM image_store');
    for (const d of dishes) {
      const links = await all(`SELECT di.quantity, di.unit, di.note, i.name FROM dish_ingredients di
        JOIN ingredients i ON i.id = di.ingredient_id WHERE di.dish_id = ? ORDER BY di.id`, [d.id]);
      const steps = await all('SELECT text FROM dish_steps WHERE dish_id = ? ORDER BY step_no', [d.id]);
      const ingJson = JSON.stringify(links.map(l => l.note
        ? { name: l.name, amount: fmtQty(l.quantity), unit: l.unit, note: l.note }
        : { name: l.name, amount: fmtQty(l.quantity), unit: l.unit }));
      const stepsJson = JSON.stringify(steps.map(s => s.text));
      const meals = { breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner', snack: 'snack' };
      await q(`INSERT OR REPLACE INTO recipes
        (id, title, category, calories, protein, fat, carbs, description, benefits, ingredients,
         recipe_steps, image_url, goals, photo_query, category_hint)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.id, d.title, meals[d.meal_type] || 'lunch', d.calories, d.protein, d.fat, d.carbs,
         d.description || '', '', ingJson, stepsJson, d.photo_url || '', JSON.stringify(['lose', 'maintain', 'gain']),
         d.title + ' блюдо', d.category]);
    }
    // хэш источника: seed:recipes больше не используется (legacy не пересеивается),
    // но записываем факт импорта для отчёта/диагностики
    await q("INSERT OR REPLACE INTO meta (key, value) VALUES ('unitools:import', ?)",
      [JSON.stringify({ file: path.basename(SRC), imported: stats.imported, at: new Date().toISOString() })]);
  }

  console.log('------------------------------');
  console.log('Импортировано: ' + stats.imported + ' из ' + stats.total);
  console.log('Приёмы пищи: завтрак=' + stats.meal.breakfast + ' обед=' + stats.meal.lunch + ' ужин=' + stats.meal.dinner + ' перекус=' + stats.meal.snack);
  console.log('Уникальных ингредиентов: ' + (DRY ? '(dry)' : ingCache.size) + ', связей: ' + stats.links + ', шагов: ' + stats.steps);
  console.log('Пропущено: неполный RU=' + stats.skippedLang + ', битые данные=' + stats.skippedBad);
  // dry-режим используется тестами для создания схемы на пустой БД: выходим только
  // после полного опустошения очереди sqlite3, иначе DDL обрывается на середине
  db.run("SELECT 1", [], () => process.exit(0));
})().catch(e => { console.error('Ошибка импорта:', e.message); process.exit(1); });
