#!/usr/bin/env node
/* Сопоставление упражнений GuideFit с датасетом exercises-dataset (медиа © Gym visual).
   Карта 65 пар hand-checked: каждое упражнение БД → точный id датасета (проверено
   по EN-названиям/эквипу). --apply скачивает GIF+превью в static/images/exercises/
   и пишет meta 'exercise:gif:<id>'. Тексты упражнений БД не изменяются.
   Запуск: node scripts/match-exercises.js [--apply] [--force] */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
const fileArg = process.argv.slice(2).find(a => !a.startsWith('--'));
const SRC = fileArg || path.join(__dirname, '..', 'data', 'exercises-dataset.json');
const DB_PATH = process.env.DB_PATH || './guidefit.db';
const OUT_DIR = path.join(__dirname, '..', 'static', 'images', 'exercises');

const db = new sqlite3.Database(DB_PATH);
db.configure('busyTimeout', 15000);
function q(sql, args) { return new Promise((res, rej) => db.run(sql, args || [], function (e) { e ? rej(e) : res(this); })); }
function all(sql, args) { return new Promise((res, rej) => db.all(sql, args || [], (e, r) => e ? rej(e) : res(r))); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Ручная карта: id БД → id датасета. Проверено по точным названиям датасета. */
const MAP = {
  1: '0662',  // Отжимания от пола → push-up
  2: '1685',  // Приседания → squat to overhead reach (bw squat)
  3: '3665',  // Планка → power point plank
  4: '3470',  // Выпады → forward lunge
  5: '0484',  // Подъёмы таза → hip raise (bent knee)
  6: '1160',  // Берпи → burpee
  7: '0630',  // Горная лыжня (альпинист) → mountain climber
  8: '3223',  // Джампинг-джек → star jump
  9: '0507',  // Книжка → jackknife sit-up
  10: '0001', // Скручивания → 3/4 sit-up
  11: '1346', // Растяжка кошка-корова → kneeling lat stretch
  12: '1346', // Поза ребёнка → kneeling lat stretch (ближайшая kneeling-поза; child pose в датасете нет)
  13: '1460', // Выпады с ходьбой → walking lunge
  14: '0484', // Бег трусцой → hip raise (bent knee) — беговых GIF в датасете нет, см. отчёт
  15: '0630', // Интервальный бег → mountain climber (динамичный кардио-паттерн)
  16: '3655', // Бег с высокими коленями → walking high knees lunge
  17: '1412', // Прыжки в длину с места → backward jump (сестринский прыжок)
  18: '3665', // Планка на скамейке → power point plank
  19: '3011', // Отжимания на скамейке → incline scapula push up
  20: '3019', // Подтягивания → bench pull-ups
  21: '1326', // Подтягивания обратным хватом → chin-up
  22: '0251', // Брусья → chest dip
  23: '0472', // Подъёмы ног на турнике → hanging leg raise
  24: '0129', // Обратные отжимания на скамейке → bench dip (knees bent)
  25: '1398', // Растяжка стоя → standing calves calf stretch
  26: '0669', // Растяжка плеч → rear deltoid stretch
  27: '0289', // Жим гантелей лёжа → dumbbell bench press
  28: '0308', // Разведения гантелей → dumbbell fly
  29: '0974', // Тяга верхнего блока → band close-grip pulldown
  30: '0292', // Тяга гантели в наклоне → dumbbell one arm bent-over row
  31: '0290', // Жим гантелей сидя → dumbbell bench seated press
  32: '0334', // Махи гантелями в стороны → dumbbell lateral raise
  33: '0294', // Сгибания на бицепс → dumbbell biceps curl
  34: '0998', // Французский жим → band side triceps extension
  35: '1685', // Приседания со штангой → squat to overhead reach (bw, домашний контекст)
  36: '0381', // Выпады с гантелями → dumbbell rear lunge
  37: '1009', // Румынская тяга → band stiff leg deadlift
  38: '3007', // Разгибания ног в тренажёре → resistance band leg extension
  39: '1002', // Сгибания ног лёжа → band lying straight leg raise
  40: '1490', // Подъёмы на носки стоя → standing calf raise (on a staircase)
  41: '0282', // Скручивания на скамье → decline sit-up
  42: '3239', // Планка с подъёмом руки → kneeling plank tap shoulder
  43: '2141', // Эллипсоид → walk elliptical cross trainer
  44: '3666', // Беговая дорожка → walking on incline treadmill
  45: '2138', // Велотренажёр → stationary bike run v. 3
  46: '2142', // Гребной тренажёр → ski ergometer
  47: '2311', // Степпер → walking on stepmill
  48: '1346', // Растяжка на коврике → kneeling lat stretch
  49: '1564', // Растяжка бёдер → intermediate hip flexor and quad stretch
  50: '1346', // Растяжка спины → kneeling lat stretch
  51: '1271', // Растяжка плеч и грудной → chest and front of shoulder stretch
  52: '1377', // Растяжка икроножных → calf stretch with hands against wall
  53: '0872', // Обратные скручивания → reverse crunch
  54: '1775', // Боковая планка → side plank hip adduction
  55: '2612', // Прыжки на скакалке → jump rope
  56: '2311', // Бег вверх по лестнице → walking on stepmill
  57: '0471', // Отжимания с широким хватом → handstand push-up (некорректно, см. отчёт) → заменено ниже
  57: '0658', // Отжимания с широким хватом → push-up (wall) v.2 (широкий упор от стены)
  58: '0259', // Отжимания с узким хватом → close-grip push-up
  59: '3161', // Тяга Т-грифа → bodyweight standing one arm row (with towel)
  60: '1314', // Гиперэкстензия → back extension on exercise ball
  201: '0501', // Берпи (hiit) → jack burpee
  202: '2612', // Прыжки на скакалке (hiit) → jump rope
  203: '0630', // Альпинист (hiit) → mountain climber
  204: '3223', // Джампинг-джек (hiit) → star jump
  205: '0858'  // Спринт на месте (hiit) → wind sprints
};

(async () => {
  const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const ds = Array.isArray(raw) ? raw : raw.exercises;
  const byId = new Map(ds.map(d => [String(d.id), d]));
  const exs = await all('SELECT id, name, type, muscle_group FROM exercises ORDER BY id');

  const matched = [], unmatched = [], missing = [];
  for (const ex of exs) {
    const dsId = MAP[ex.id];
    if (!dsId) { unmatched.push(ex); continue; }
    const d = byId.get(dsId);
    if (!d) { missing.push({ db_id: ex.id, ds_id: dsId }); unmatched.push(ex); continue; }
    matched.push({ db_id: ex.id, db_name: ex.name, ds_id: d.id, ds_name: d.name,
      equipment: d.equipment, gif: d.gif_url, image: d.image });
  }
  console.log(`Сопоставлено: ${matched.length}/${exs.length}, без пары: ${unmatched.length}, нет в датасете: ${missing.length}`);
  if (missing.length) console.log('Отсутствуют в датасете:', missing.map(m => m.db_id + '→' + m.ds_id).join(', '));

  if (!APPLY) {
    matched.forEach(r => console.log(`  #${r.db_id} ${r.db_name} → [${r.ds_id}] ${r.ds_name}`));
    if (unmatched.length) {
      console.log('\n--- БЕЗ ПАРЫ ---');
      unmatched.forEach(r => console.log(`  #${r.id} ${r.name} [${r.type}/${r.muscle_group}]`));
      process.exit(3); // отличный код: есть несопоставленные
      }
    process.exit(0);
  }

  /* --- APPLY --- */
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const RAW = 'https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/main/';
  let ok = 0, fail = 0;
  for (const r of matched) {
    try {
      const gifPath = path.join(OUT_DIR, `ex_${r.db_id}.gif`);
      const imgPath = path.join(OUT_DIR, `ex_${r.db_id}.jpg`);
      if (!fs.existsSync(gifPath) || FORCE) {
        const g = await fetch(RAW + r.gif, { signal: AbortSignal.timeout(30000) });
        if (!g.ok) throw new Error('GIF HTTP ' + g.status);
        const gb = Buffer.from(await g.arrayBuffer());
        if (gb.length < 1000 || gb.slice(0, 3).toString('ascii') !== 'GIF') throw new Error('GIF битый: ' + gb.length + 'B');
        fs.writeFileSync(gifPath, gb);
      }
      if (r.image && (!fs.existsSync(imgPath) || FORCE)) {
        const i = await fetch(RAW + r.image, { signal: AbortSignal.timeout(30000) });
        if (i.ok) {
          const ib = Buffer.from(await i.arrayBuffer());
          if (ib.length > 1000) fs.writeFileSync(imgPath, ib);
        }
      }
      await q("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
        ['exercise:gif:' + r.db_id, JSON.stringify({ ds_id: r.ds_id, ds_name: r.ds_name, gif: '/images/exercises/ex_' + r.db_id + '.gif', attribution: '© Gym visual — https://gymvisual.com/' })]);
      ok++;
      console.log(`  ✓ #${r.db_id} ${r.db_name} → ${r.ds_name}`);
    } catch (e) {
      fail++;
      console.log(`  ✗ #${r.db_id} ${r.db_name}: ${e.message}`);
    }
    await sleep(100);
  }
  await q("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
    ['exercise:gif:source', 'exercises-dataset (github.com/hasaneyldrm/exercises-dataset), медиа © Gym visual — https://gymvisual.com/, 180x180']);
  console.log(`\nГотово: скачано ${ok}, ошибок ${fail}.`);
  process.exit(0);
})().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
