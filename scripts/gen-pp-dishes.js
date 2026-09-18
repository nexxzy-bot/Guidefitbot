#!/usr/bin/env node
/* Автономный генератор ПП-блюд через Gemini API.
   Наполняет нормализованные таблицы dishes / ingredients / dish_ingredients / dish_steps
   (и legacy-зеркало recipes для существующего UI/бота/дневника).

   План: 5 суточных профилей (1500/2000/2500/3000/3500 ккал) × 4 категории
         (завтрак 25%, перекус 15%, обед 35%, ужин 25%) × ровно 100 блюд = 2000 блюд.
   Батчи: 10 блюд за один запрос к Gemini; если после валидации прошло меньше 10 —
         добирающие раунды (до 3 запросов на батч), чтобы план реально сходился.
   Стейт: data/gen-state.json (атомарная запись после каждого принятого батча).
         Нет стейта => HARD RESET: полная очистка таблиц блюд/ингредиентов
         (пользовательские данные — users, дневники, вода, согласия — не трогаются).
   Лимиты: при 429/исчерпании квот — лог, пауза ровно 24 часа, автопродолжение
         бесконечным циклом. Транзиентные ошибки — ретрай через 60с.
   Фото: не трогаем (Pexels-пайплайн отдельно), image_url остаётся пустым.

   Запуск: node scripts/gen-pp-dishes.js
   Флаги:  --dry-run  одна тестовая итерация: запрос к Gemini + валидация, без БД и стейта
           --nowait   вместо сна 24ч — выход с кодом 2 (для тестов) */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = process.env.DB_PATH || './guidefit.db';
const db = new sqlite3.Database(DB_PATH);
db.configure('busyTimeout', 15000);

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-3.6-flash'; // 2.0-flash удалён из API (подсказку вернул сам сервис)
/* v31.2: основная модель бывает перегружена (503 high demand) — фолбэк на стабильную
   2.5-flash. Перебираем модели по очереди, пока одна не ответит рабочим ответом. */
const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-flash-lite-latest'];
const ALL_MODELS = [MODEL, ...FALLBACK_MODELS];
let modelIdx = 0;
const modelDead = new Set(); // индексы моделей с исчерпанной дневной квотой
// GEMINI_URL — тестовое отверстие для мок-сервера (в проде не задаётся)
const API_URL = process.env.GEMINI_URL || null;

const DRY_RUN = process.argv.includes('--dry-run');
const NOWAIT = process.argv.includes('--nowait');
const limitArg = process.argv.indexOf('--limit-batches');
const LIMIT_BATCHES = limitArg > -1 ? parseInt(process.argv[limitArg + 1]) || 0 : 0;

/* ============ план генерации ============ */
const PROFILES = [1500, 2000, 2500, 3000, 3500];
const CATS = {
  breakfast: { ru: 'завтрак', share: 0.25, maxMin: 10, proteinPct: 30, fatPct: 25 },
  snack:     { ru: 'перекус', share: 0.15, maxMin: 10, proteinPct: 40, fatPct: 30 },
  lunch:     { ru: 'обед',    share: 0.35, maxMin: 20, proteinPct: 30, fatPct: 25 },
  dinner:    { ru: 'ужин',    share: 0.25, maxMin: 20, proteinPct: 30, fatPct: 25 }
};
const CAT_ORDER = ['breakfast', 'snack', 'lunch', 'dinner'];
const PER_CAT = 100; // блюд каждой категории в каждом профиле
const BATCH = 10;    // блюд за один запрос к Gemini
const MAX_ROUNDS = 3; // добирающих запросов на батч, если валидация отсеяла часть

/* ============ promise-обёртки sqlite3 ============ */
function q(sql, args) { return new Promise((res, rej) => db.run(sql, args || [], function (e) { e ? rej(e) : res(this); })); }
function get(sql, args) { return new Promise((res, rej) => db.get(sql, args || [], (e, r) => e ? rej(e) : res(r))); }
function all(sql, args) { return new Promise((res, rej) => db.all(sql, args || [], (e, r) => e ? rej(e) : res(r))); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============ стейт ============ */
// GEN_STATE_FILE позволяет изолировать стейт в тестах (по умолчанию — data/gen-state.json)
const STATE_FILE = process.env.GEN_STATE_FILE || path.join(__dirname, '..', 'data', 'gen-state.json');

function ensureSchema() {
  // идемпотентное создание схемы блюд: свежая/пустая БД больше не роняет скрипт
  return Promise.all([
    q(`CREATE TABLE IF NOT EXISTS dishes (
      id INTEGER PRIMARY KEY, slug TEXT UNIQUE, title TEXT NOT NULL, meal_type TEXT NOT NULL,
      calories REAL, protein REAL, fat REAL, carbs REAL,
      base_servings INTEGER DEFAULT 1, prep_minutes INTEGER, cook_minutes INTEGER,
      description TEXT, category TEXT, country TEXT, difficulty TEXT,
      attribution TEXT, photo_url TEXT)`),
    q('CREATE INDEX IF NOT EXISTS idx_dishes_meal_kcal ON dishes(meal_type, calories)'),
    q(`CREATE TABLE IF NOT EXISTS ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, unit TEXT)`),
    q('CREATE INDEX IF NOT EXISTS idx_ingredients_name ON ingredients(name)'),
    q(`CREATE TABLE IF NOT EXISTS dish_ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dish_id INTEGER NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
      ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
      quantity REAL, unit TEXT NOT NULL,
      scaling TEXT NOT NULL DEFAULT 'linear' CHECK (scaling IN ('linear','damped','fixed')),
      note TEXT)`),
    q(`CREATE TABLE IF NOT EXISTS dish_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dish_id INTEGER NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
      step_no INTEGER NOT NULL, text TEXT NOT NULL, minutes INTEGER)`),
    q('CREATE INDEX IF NOT EXISTS idx_dish_steps_dish ON dish_steps(dish_id, step_no)'),
    q('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
  ]);
}

function hardReset() {
  return ensureSchema().then(() => q('BEGIN').then(() => Promise.all([
    q('DELETE FROM dish_ingredients'),
    q('DELETE FROM dish_steps'),
    q('DELETE FROM dishes'),
    q('DELETE FROM ingredients'),
    q('DELETE FROM image_store'),
    q('DELETE FROM recipes'),
    q("DELETE FROM sqlite_sequence WHERE name = 'ingredients'")
  ])).then(() => q('COMMIT')).then(() => {
    console.log('HARD RESET: dishes/ingredients/dish_ingredients/dish_steps/recipes/image_store очищены (пользовательские данные не тронуты)');
  })).catch(e => q('ROLLBACK').then(() => { throw e; }));
}

let state = { batch: 0, done: {} };
let freshStart = true;
if (fs.existsSync(STATE_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = { batch: parsed.batch | 0, done: parsed.done || {} };
    freshStart = false;
    const totalDone = Object.values(state.done).reduce((s, c) => s + Object.values(c).reduce((a, b) => a + b, 0), 0);
    console.log(`Найден стейт: батчей ${state.batch}, блюд ${totalDone}/2000 — продолжаем с места остановки`);
  } catch (e) {
    console.error('Стейт повреждён — считаем этот запуск первым (HARD RESET):', e.message);
  }
}

function saveState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, STATE_FILE); // атомарно: прерванная запись не портит стейт
}

/* ============ правила РФ-продуктов: валидация ответов Gemini ============ */
const BAN_RE = new RegExp('(' + [
  'шиитаке', 'авокадо', 'киноа', 'тофу', 'трюфель', 'манго', 'папайя', 'личи', 'маракуйя',
  'гуава', 'кокосовое молоко', 'кокосовая мука', 'чиа', 'спирулина', 'матча', 'эдамаме',
  'васаби', 'вустерширск', 'мирин', 'аррорут', 'тапиока', 'нори', 'вакаме', 'комбу',
  'хумус', 'фалафель', 'тахини', 'мидии', 'устрицы', 'гребешок', 'омар', 'лобстер',
  'фуа-гра', 'мисо', 'кэроб', 'стевия', 'проростки'
].join('|') + ')', 'i');
const RU_RE = /[А-Яа-яЁё]/;
const LATIN_WORD = /[A-Za-z]{3,}/;

function normName(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^а-я0-9 ]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

/* ============ Gemini ============ */
function apiUrl() {
  if (API_URL) return API_URL; // тестовый мок
  const m = ALL_MODELS[modelIdx % ALL_MODELS.length];
  return `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
}
async function callGemini(prompt) {
  const body = (withThinking) => JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    // thinkingBudget:0 — 2.5-flash «думает» и срезает MAX_TOKENS на 8192 (проверено).
    // Часть моделей не знает thinkingConfig (400 INVALID_ARGUMENT) — второй попыткой шлём без него.
    generationConfig: withThinking
      ? { temperature: 1.15, maxOutputTokens: 32768, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } }
      : { temperature: 1.15, maxOutputTokens: 32768, responseMimeType: 'application/json' }
  });
  let res = await fetch(apiUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    // без таймаута запрос мог висеть вечно (найдено на dry-run) — в автономном режиме недопустимо
    signal: AbortSignal.timeout(120000),
    body: body(true)
  });
  if (res.status === 400) {
    res = await fetch(apiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      signal: AbortSignal.timeout(120000),
      body: body(false)
    });
  }
  return res;
}

function macroTargets(profile, catKey) {
  const c = CATS[catKey];
  const kcal = Math.round(profile * c.share);
  const proteinG = Math.round(kcal * c.proteinPct / 100 / 4);
  const fatG = Math.round(kcal * c.fatPct / 100 / 9);
  const carbsG = Math.max(5, Math.round((kcal - proteinG * 4 - fatG * 9) / 4));
  return { kcal, proteinG, fatG, carbsG };
}

function buildPrompt(profile, catKey) {
  const c = CATS[catKey];
  const t = macroTargets(profile, catKey);
  return `Сгенерируй ровно ${BATCH} РАЗНЫХ реальных блюд для правильного питания: категория «${c.ru}», суточная норма человека ${profile} ккал.

Целевая калорийность ОДНОГО блюда: ${t.kcal} ккал (допуск ±10%).
Целевые БЖУ на блюдо: белки ~${t.proteinG} г, жиры ~${t.fatG} г, углеводы ~${t.carbsG} г.

ЖЁСТКИЕ ПРАВИЛА:
1. Ингредиенты — только простые и доступные в России: курица, индейка, фарш (говяжий/свиной/куриный), свинина, говядина, тунец, минтай, треска, сельдь, яйца, творог, сыр, сметана, кефир, молоко, крупы (гречка, рис, овсянка, перловка, булгур, пшено, макароны из твёрдых сортов), картофель, капуста, морковь, свёкла, лук, чеснок, помидоры, огурцы, кабачок, баклажан, болгарский перец, тыква, шампиньоны, яблоки, груши, ягоды, бананы, зелень, лимон. НИКАКОЙ экзотики: без авокадо, шиитаке, киноа, тофу, манго, чиа, кокосового молока, деликатесных морепродуктов.
2. Блюда должны быть СОЧНЫМИ, не сухими: соусы на сметане/кефире/томатной основе, тушение, запекание под сыром, маринование, томление. Готовка только: духовка, сковорода, аэрогриль — обычная бытовая техника.
3. Время приготовления: не больше ${c.maxMin} минут.
4. Порционность: ровно 1 порция, граммовки точные и реальные.
5. Всё на русском языке, без англицизмов, названия без кавычек.
6. КБЖУ должны сходиться между собой: калории ≈ 4×белки + 9×жиры + 4×углеводы (допуск ±15%).

Ответь СТРОГО одним JSON-массивом из ${BATCH} объектов, без пояснений и markdown:
[{"name":"Название блюда","ingredients":[{"name":"Куриное филе","amount":200,"unit":"г"}],"calories":450,"protein":35,"fat":12,"carbs":40,"minutes":15,"steps":["шаг 1","шаг 2","шаг 3"]}]
Поля: name (строка), ingredients (3-8 шт., amount — число, unit — «г»/«мл»/«шт»/«ч. л.»/«ст. л.»/«щепотка»), calories/protein/fat/carbs (числа), minutes (число ≤ ${c.maxMin}), steps (3-6 строк).`;
}

async function generateBatch(profile, catKey) {
  const res = await callGemini(buildPrompt(profile, catKey));
  if (res.status === 429 || res.status === 503) {
    // различаем минутный (RPM) и дневной лимиты: у дневного в details есть QuotaFailure + RetryInfo с большими задержками
    const j = await res.json().catch(() => ({}));
    const det = (j.error && j.error.details) || [];
    const isOverload = res.status === 503; // «high demand» — пробуем другую модель
    const curIdx = modelIdx % ALL_MODELS.length; // модель-виновник (до инкремента)
    if (isOverload) modelIdx++; // следующая попытка — фолбэк-модель
    const ri = det.find(x => (x['@type'] || '').includes('RetryInfo'));
    let retryMs = null;
    if (ri && ri.retryDelay) { const m = String(ri.retryDelay).match(/^([\d.]+)s$/); if (m) retryMs = Math.ceil(parseFloat(m[1]) * 1000) + 1000; }
    const isDaily = det.some(x => (x['@type'] || '').includes('QuotaFailure') && ((x.violations || []).some(v => /PerDay|per_day|day/i.test(String(v.quotaId || '')))));
    const err = new Error('QUOTA: Gemini HTTP ' + res.status + (isDaily ? ' (дневная квота)' : ' (минутный лимит)'));
    err.quota = true; err.retryMs = retryMs; err.daily = isDaily; err.overload = isOverload;
    err.modelIdx = curIdx; // какая модель ответила ошибкой
    throw err;
  }
  if (!res.ok) {
    const err = new Error('Gemini HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
    err.transient = res.status >= 500;
    throw err;
  }
  const data = await res.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  const text = parts ? parts.map(p => p.text || '').join('') : '';
  if (!text) { const err = new Error('Пустой ответ Gemini (вероятно, обрезка JSON)'); err.empty = true; throw err; }
  /* модель иногда присылает «размышления» до/после JSON — вычленяем массив,
     балансируя скобки, а не жадным регэкспом (\[...\] ловит лишний хвост) */
  const arrStart = text.indexOf('[');
  let raw = null;
  if (arrStart !== -1) {
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = arrStart; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === '[') depth++;
      else if (ch === ']') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end !== -1) raw = text.slice(arrStart, end + 1);
  }
  if (!raw) { const err = new Error('Gemini не вернул JSON-массив: ' + text.slice(0, 200)); err.badjson = true; throw err; }
  let arr;
  try { arr = JSON.parse(raw); } catch (e) { const err = new Error('JSON не распарсился: ' + e.message); err.badjson = true; throw err; }
  if (!Array.isArray(arr) || !arr.length) throw new Error('Ответ не массив или пуст');
  return arr;
}

/* ============ валидация (без обращения к БД) ============ */
function validateDish(d, catKey) {
  const name = String(d && d.name || '').trim().replace(/["«»]/g, '').replace(/\s+/g, ' ').slice(0, 120);
  if (!name || !RU_RE.test(name) || LATIN_WORD.test(name)) return null;   // нерусифицированное
  if (BAN_RE.test(name)) return null;

  const kcal = Math.round(Number(d.calories) || 0);
  const protein = Math.round(Number(d.protein) || 0);
  const fat = Math.round(Number(d.fat) || 0);
  const carbs = Math.round(Number(d.carbs) || 0);
  if (kcal < 30 || kcal > 1200) return null;
  if (protein < 0 || protein > 90 || fat < 0 || fat > 80 || carbs < 0 || carbs > 150) return null;
  const sum = protein * 4 + fat * 9 + carbs * 4;                          // КБЖУ бьются между собой
  if (!sum || Math.abs(sum - kcal) / kcal > 0.4) return null;

  const maxMin = CATS[catKey].maxMin;
  const minutes = Math.min(Math.round(Number(d.minutes) || maxMin), maxMin);
  const steps = (Array.isArray(d.steps) ? d.steps : [])
    .map(s => String(s || '').trim()).filter(s => s && RU_RE.test(s)).slice(0, 8);
  if (steps.length < 2) return null;

  const ings = [];
  for (const ing of (Array.isArray(d.ingredients) ? d.ingredients : [])) {
    const nm = String(ing && ing.name || '').trim().replace(/\s+/g, ' ');
    if (!nm || !RU_RE.test(nm) || LATIN_WORD.test(nm) || BAN_RE.test(nm)) return null; // экзотика/латиница => бракуем блюдо
    const unit = String(ing && ing.unit || 'г').trim().slice(0, 24) || 'г';
    const amount = Number(ing && ing.amount);
    ings.push({ name: nm, unit, amount: Number.isFinite(amount) && amount > 0 ? amount : null });
  }
  if (ings.length < 2 || ings.length > 10) return null;

  return { name, key: normName(name), kcal, protein, fat, carbs, minutes, steps, ings };
}

/* ============ запись в БД ============ */
async function ensureIngredientId(nm, unit) {
  const key = nm.toLowerCase() + '|' + unit;
  let id = ingCache.get(key);
  if (id === undefined) {
    /* UNIQUE в БД стоит на name (unit вне ограничения): сначала ищем по имени —
       иначе INSERT ловит SQLITE_CONSTRAINT, когда тот же ингредиент уже есть с другой единицей */
    const row = await get('SELECT id, unit FROM ingredients WHERE name = ?', [nm]);
    if (row) {
      id = row.id;
      ingCache.set(nm.toLowerCase() + '|' + (row.unit || ''), id); // уже известен и под другой единицей
    } else {
      const r = await q('INSERT INTO ingredients (name, unit) VALUES (?, ?)', [nm, unit]);
      id = r.lastID;
    }
    ingCache.set(key, id);
  }
  return id;
}

async function insertDish(v) {
  const next = await get('SELECT COALESCE(MAX(id), 19999) + 1 AS id FROM dishes');
  const id = Math.max(next.id, 20501); // новые блюда идут после импорта Unitools (20000–20500)

  await q(`INSERT INTO dishes (id, slug, title, meal_type, calories, protein, fat, carbs,
            base_servings, prep_minutes, cook_minutes, description, category, country, difficulty,
            attribution, photo_url)
            VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, 'generated', 'RU', 'easy',
                    'Gemini API (автогенерация GuideFit)', '')`,
    [id, v.name, v.cat, v.kcal, v.protein, v.fat, v.carbs, v.minutes, v.minutes]);

  const ingJson = [];
  for (const ing of v.ings) {
    const iid = await ensureIngredientId(ing.name, ing.unit);
    await q('INSERT INTO dish_ingredients (dish_id, ingredient_id, quantity, unit, scaling) VALUES (?, ?, ?, ?, ?)',
      [id, iid, ing.amount, ing.unit, 'linear']);
    ingJson.push({ name: ing.name, amount: ing.amount, unit: ing.unit });
  }
  for (let i = 0; i < v.steps.length; i++) {
    await q('INSERT INTO dish_steps (dish_id, step_no, text) VALUES (?, ?, ?)', [id, i + 1, v.steps[i]]);
  }

  // legacy-зеркало: весь существующий UI/бот/дневник работают без изменений
  await q(`INSERT OR REPLACE INTO recipes
    (id, title, category, calories, protein, fat, carbs, description, benefits, ingredients,
     recipe_steps, image_url, goals, photo_query, category_hint)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, '', ?, ?, 'generated')`,
    [id, v.name, v.cat, v.kcal, v.protein, v.fat, v.carbs,
      JSON.stringify(ingJson), JSON.stringify(v.steps),
      JSON.stringify(['lose', 'maintain', 'gain']), v.name + ' блюдо']);

  usedNames.add(v.key);
  return id;
}

async function insertBatch(validDishes) {
  await q('BEGIN');
  try {
    for (const v of validDishes) v.id = await insertDish(v);
    await q('COMMIT');
  } catch (e) {
    await q('ROLLBACK');
    throw e;
  }
}

/* ============ основной цикл ============ */
let ingCache = new Map();  // «имя|ед.» -> id
let usedNames = new Set(); // сквозная дедупликация названий (нормализованных)

async function main() {
  if (!GEMINI_KEY) { console.error('Нет GEMINI_API_KEY в .env'); process.exit(1); }

  /* v31.1: HARD RESET при первом запуске сносил бы каталог Unitools (501 блюдо) — еда пропала бы
     у пользователей на дни, пока генератор дойдёт до 2000. Новый генератор добавляет свои блюда
     ПОВЕРХ существующего каталога (id 20501+), дедупликация названий не даст дублей.
     Полный снос возможен вручную: GEN_HARD_RESET=1 node scripts/gen-pp-dishes.js */
  if (freshStart && !DRY_RUN && process.env.GEN_HARD_RESET === '1') await hardReset();
  else await ensureSchema(); // таблицы гарантируем в любом случае

  // кеш ингредиентов и занятых названий из БД (после возможного RESET)
  const ings = await all('SELECT id, name, unit FROM ingredients');
  for (const i of ings) ingCache.set(String(i.name).toLowerCase() + '|' + i.unit, i.id);
  const dishRows = await all('SELECT title FROM dishes');
  for (const n of dishRows) usedNames.add(normName(n.title));
  console.log(`БД: блюд ${dishRows.length}, ингредиентов ${ings.length}`);

  while (true) { // бесконечный цикл; единственный выход — весь план сгенерирован
    // следующий незаполненный слот плана
    let task = null;
    outer:
    for (const p of PROFILES) {
      for (const c of CAT_ORDER) {
        const done = (state.done[p] && state.done[p][c]) || 0;
        if (done < PER_CAT) { task = { profile: p, cat: c, done }; break outer; }
      }
    }
    if (!task) {
      const total = PROFILES.length * CAT_ORDER.length * PER_CAT;
      console.log(`\nПЛАН ВЫПОЛНЕН: ${total} блюд сгенерировано и записано. Готово.`);
      process.exit(0);
    }

    const targetKcal = Math.round(task.profile * CATS[task.cat].share);
    const remaining = PER_CAT - task.done;
    const need = Math.min(BATCH, remaining);
    console.log(`\n[батч #${state.batch + 1}] ${task.cat} / профиль ${task.profile} ккал → блюда по ${targetKcal} ккал (ещё ${remaining}, запрашиваем по ${BATCH})`);

    // до MAX_ROUNDS запросов, пока не наберём need валидных уникальных блюд
    let collected = [];
    try {
      for (let round = 1; round <= MAX_ROUNDS && collected.length < need; round++) {
        const raw = await generateBatch(task.profile, task.cat);
        const localKeys = new Set(collected.map(v => v.key));
        let good = 0;
        for (const d of raw) {
          if (collected.length >= need) break;
          const v = validateDish(d, task.cat);
          if (v && !usedNames.has(v.key) && !localKeys.has(v.key)) { v.cat = task.cat; collected.push(v); localKeys.add(v.key); good++; }
        }
        console.log(`  раунд ${round}: от Gemini ${raw.length}, прошло валидацию ${good}, набрано ${collected.length}/${need}`);
        if (round < MAX_ROUNDS && collected.length < need) await sleep(1500);
      }
    } catch (e) {
      if (e.quota) {
        if (NOWAIT) { console.error('429 / квота Gemini. --nowait: выходим.'); process.exit(2); }
        if (e.daily) {
          modelDead.add(e.modelIdx);
          const alive = ALL_MODELS.map((_, i) => i).filter(i => !modelDead.has(i));
          if (alive.length) {
            modelIdx = alive[0];
            console.error('Дневная квота ' + ALL_MODELS[e.modelIdx] + ' исчерпана — переключаюсь на ' + ALL_MODELS[modelIdx] + ' через 10с');
            await sleep(10000);
            continue;
          }
          console.error('Дневные квоты ВСЕХ моделей (' + ALL_MODELS.join(', ') + ') исчерпаны. Засыпаю на 24 часа, потом продолжаю автоматически…');
          saveState(); // прогресс всех принятых батчей сохранён
          await sleep(24 * 60 * 60 * 1000); // ровно 24 часа, затем повтор текущего батча
          modelDead.clear(); // за сутки квоты обновляются
          continue;
        }
        const wait = e.overload ? 20000 : (e.retryMs || 70000); // перегрузка другой модели — короткая пауза
        // минутный лимит/перегрузка конкретной модели — следующая попытка на другой модели
        modelIdx = (e.modelIdx + 1) % ALL_MODELS.length;
        console.error((e.overload ? '503 перегрузка' : '429 (минутный лимит' + (e.retryMs ? ', retry через ' + Math.round(e.retryMs / 1000) + 'с' : '') + ')') + ' на ' + ALL_MODELS[e.modelIdx] + '. Пауза ' + Math.round(wait / 1000) + 'с, дальше — ' + ALL_MODELS[modelIdx] + '…');
        await sleep(wait);
        continue;
      }
      if (e.badjson) { console.log('Кривой ответ (не JSON) — ретрай через 15с'); await sleep(15000); continue; }
      if (e.empty) { console.log('Пустой ответ Gemini — ретрай через 20с'); await sleep(20000); continue; }
      console.error('Ошибка генерации: ' + e.message + (e.transient ? ' (транзиентная)' : ''));
      console.log('Ретрай через 60с…');
      await sleep(60000);
      continue;
    }

    if (DRY_RUN) {
      console.log('--dry-run: валидных блюд', collected.length, '; пример:', JSON.stringify(collected[0] || null, null, 1).slice(0, 500));
      process.exit(0);
    }
    if (!collected.length) { console.log('Ни одного валидного блюда за ' + MAX_ROUNDS + ' раунда — ретрай через 60с'); await sleep(60000); continue; }

    const take = collected.slice(0, need);
    try {
      await insertBatch(take);
    } catch (e) {
      console.error('Ошибка записи в БД (батч откачен): ' + e.message + ' — ретрай через 60с');
      await sleep(60000);
      continue;
    }

    state.batch++;
    if (!state.done[task.profile]) state.done[task.profile] = {};
    state.done[task.profile][task.cat] = task.done + take.length;
    saveState();
    const totalDone = Object.values(state.done).reduce((s, c) => s + Object.values(c).reduce((a, b) => a + b, 0), 0);
    console.log(`Батч принят: +${take.length}. Итого ${totalDone}/2000 (${task.profile}/${task.cat}: ${task.done + collected.length}/${PER_CAT})`);
    saveStateBeforeExit();
    await sleep(1500); // бережная пауза между запросами
  }
}

function saveStateBeforeExit() {
  if (LIMIT_BATCHES && state.batch >= LIMIT_BATCHES) {
    console.log(`--limit-batches=${LIMIT_BATCHES}: достигнут лимит, корректно выходим (стейт сохранён)`);
    process.exit(0);
  }
}

main().then(() => process.exit(0)).catch(e => {
  console.error('Фатальная ошибка:', e.message);
  process.exit(1);
});
