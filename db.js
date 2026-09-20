const sqlite3 = require('sqlite3').verbose();
// Путь к базе можно переопределить (тесты и резервное копирование используют отдельный файл)
const DB_FILE = process.env.DB_PATH || './guidefit.db';
const db = new sqlite3.Database(DB_FILE);
const fs = require('fs');
const crypto = require('crypto');

// v23: WAL + busy timeout — нет блокировок БД при параллельных запросах (сервер + бот + скрипты)
db.serialize(() => {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 15000");
});

db.serialize(() => {
  // Все колонки объявлены сразу — на чистой базе не зависим от порядка ALTER-ов ниже.
  // provider — способ создания аккаунта: 'anon' (устройство) или 'vk'.
  db.run(`CREATE TABLE IF NOT EXISTS users (
    tg_id TEXT PRIMARY KEY, name TEXT, goal TEXT, gender TEXT,
    age INTEGER, height INTEGER, current_weight REAL, target_weight REAL,
    calorie_norm INTEGER, activity_level TEXT DEFAULT 'moderate',
    meal_count INTEGER DEFAULT 4, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    notify_enabled INTEGER DEFAULT 1, last_seen DATETIME,
    provider TEXT DEFAULT 'anon', avatar TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, tg_id TEXT, created_at INTEGER
  )`);
  db.all("PRAGMA table_info(users)", [], (e2, cols2) => {
    if (!e2 && cols2 && !cols2.some(c => c.name === 'notify_enabled')) db.run("ALTER TABLE users ADD COLUMN notify_enabled INTEGER DEFAULT 1");
    // v31: уровень подготовки (1 начинающий … 5 профессионал) — от него зависят рекомендации программ и йоги
    if (!e2 && cols2 && !cols2.some(c => c.name === 'fitness_level')) db.run("ALTER TABLE users ADD COLUMN fitness_level INTEGER");
  });
  // админка + мультиавторизация (ВК/Яндекс/Max): последний визит и провайдер.
  // tg_id остаётся единым внутренним идентификатором аккаунта ('anon:…', 'vk:456', …) —
  // это просто имя ключа в базе, назад к Telegram он отношения не имеет.
  // + фото профиля из VK (avatar)
  db.all("PRAGMA table_info(users)", [], (e3, cols3) => {
    if (!e3 && cols3) {
      if (!cols3.some(c => c.name === 'last_seen')) db.run("ALTER TABLE users ADD COLUMN last_seen DATETIME");
      if (!cols3.some(c => c.name === 'provider')) db.run("ALTER TABLE users ADD COLUMN provider TEXT DEFAULT 'tg'");
      if (!cols3.some(c => c.name === 'avatar')) db.run("ALTER TABLE users ADD COLUMN avatar TEXT");
      // v28: часовой пояс пользователя (выбор из списка, без геолокации) — от него зависят часы напоминаний
      if (!cols3.some(c => c.name === 'timezone')) db.run("ALTER TABLE users ADD COLUMN timezone TEXT");
    }
  });
  // журнал согласий (152-ФЗ, ст. 9 и 10): что и когда отметил пользователь, версии документов.
  // Доказательство согласия; удаляется вместе с аккаунтом (/api/user/delete).
  db.run(`CREATE TABLE IF NOT EXISTS consent_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id TEXT NOT NULL,
    privacy INTEGER NOT NULL DEFAULT 1,
    terms INTEGER NOT NULL DEFAULT 1,
    health INTEGER NOT NULL DEFAULT 1,
    doc_version TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_consent_log_tg ON consent_log(tg_id)`);
  // служебные метаданные (например, хэш каталогов — чтобы не пересевать БД на каждом старте)
  db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS food_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id TEXT, recipe_id INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  /* v32: все моменты времени в базе — UTC, а «день» записи считается по поясу
     пользователя при чтении (см. helpers в server.js).
     До этой версии server.js писал food_logs.timestamp как
     datetime('now','localtime'), то есть по поясу СЕРВЕРА (по умолчанию
     Europe/Moscow = UTC+3, без перехода на летнее время).
     Разово сдвигаем старые строки на -180 минут; метка в meta не даёт выполнить
     пересчёт дважды (иначе после перезапуска время уехало бы ещё раз). */
  db.get("SELECT value FROM meta WHERE key = 'tz:food_logs_utc'", [], (eTz, rowTz) => {
    if (eTz || rowTz) return;
    db.run("UPDATE food_logs SET timestamp = datetime(timestamp, '-180 minutes')", (eMig) => {
      if (eMig) return console.error('tz migration:', eMig.message);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('tz:food_logs_utc', ?)",
        [new Date().toISOString()], (eMeta) => {
          if (eMeta) return console.error('tz migration meta:', eMeta.message);
          console.log('Миграция времени: food_logs.timestamp переведён в UTC');
        });
    });
  });
  /* v32: пояс, который пользователь не выбрал, делаем явным.
     NULL и раньше означал пояс сервера — но явное значение видно в выгрузке
     данных, в админке и не выглядит как «поле забыли заполнить». */
  db.get("SELECT value FROM meta WHERE key = 'tz:backfill'", [], (eB, rowB) => {
    if (eB || rowB) return;
    db.run("UPDATE users SET timezone = ? WHERE timezone IS NULL",
      [process.env.TZ || 'Europe/Moscow'], (eB2) => {
        if (eB2) return console.error('tz backfill:', eB2.message);
        db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('tz:backfill', ?)",
          [new Date().toISOString()], (eB3) => { if (eB3) console.error('tz backfill meta:', eB3.message); });
      });
  });
  // photo_query объявлен прямо в CREATE TABLE: раньше колонка добавлялась только
  // запоздалым ALTER, и на ЧИСТОЙ базе сидирование каталога падало
  // (SQLITE_ERROR: table recipes has no column named photo_query).
  db.run(`CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY, title TEXT, category TEXT,
    calories REAL, protein REAL, fat REAL, carbs REAL,
    description TEXT, benefits TEXT, ingredients TEXT,
    recipe_steps TEXT, image_url TEXT, goals TEXT, photo_query TEXT
  )`);
  db.all("PRAGMA table_info(recipes)", [], (e, cols) => {
    if (!e && cols && !cols.some(c => c.name === 'photo_query')) db.run("ALTER TABLE recipes ADD COLUMN photo_query TEXT");
  });
  db.run(`CREATE TABLE IF NOT EXISTS exercises (
    id INTEGER PRIMARY KEY, name TEXT, location TEXT, type TEXT,
    muscle_group TEXT, description TEXT, difficulty TEXT,
    sets_default INTEGER, reps_default TEXT, rest_seconds INTEGER, tips TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS programs (
    id INTEGER PRIMARY KEY, name TEXT, location TEXT, type TEXT,
    goal TEXT, duration_weeks INTEGER, description TEXT, difficulty TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS program_days (
    id INTEGER PRIMARY KEY, program_id INTEGER, week INTEGER,
    day INTEGER, title TEXT, description TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS program_exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT, program_day_id INTEGER,
    exercise_id INTEGER, sets INTEGER, reps TEXT,
    rest_seconds INTEGER, notes TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS user_programs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id TEXT, program_id INTEGER,
    start_date TEXT, current_week INTEGER DEFAULT 1,
    current_day INTEGER DEFAULT 1, active INTEGER DEFAULT 1, completed INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS workout_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id TEXT, program_id INTEGER,
    program_day_id INTEGER, date TEXT, duration_minutes INTEGER,
    total_volume REAL, notes TEXT, completed INTEGER DEFAULT 1
  )`);
  /* v31: прогресс по новым программам (fit_programs) — отдельно от легаси user_programs */
  db.run(`CREATE TABLE IF NOT EXISTS user_programs_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id TEXT, program_id INTEGER,
    current_day_id INTEGER, start_date TEXT,
    active INTEGER DEFAULT 1, completed INTEGER DEFAULT 0
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_user_programs_v2_tg ON user_programs_v2(tg_id, active)`);
  db.run(`CREATE TABLE IF NOT EXISTS workout_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, log_id INTEGER,
    exercise_id INTEGER, set_number INTEGER, reps INTEGER, weight REAL,
    completed INTEGER DEFAULT 1
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS water_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id TEXT, date TEXT, amount_ml INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS weight_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id TEXT, date TEXT, weight REAL
  )`);
  /* v30: нормализованный каталог блюд (Unitools Recipes, CC BY-SA 4.0).
     Раздельные таблицы: каждая правится независимо, точечное изменение не задевает остальных. */
  db.run(`CREATE TABLE IF NOT EXISTS dishes (
    id INTEGER PRIMARY KEY, slug TEXT UNIQUE, title TEXT NOT NULL, meal_type TEXT NOT NULL,
    calories REAL, protein REAL, fat REAL, carbs REAL,
    base_servings INTEGER DEFAULT 1, prep_minutes INTEGER, cook_minutes INTEGER,
    description TEXT, category TEXT, country TEXT, difficulty TEXT,
    attribution TEXT, photo_url TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_dishes_meal_kcal ON dishes(meal_type, calories)`);
  // ингредиенты уникальны по русской нормализованной записи — не дублируем текстом внутри блюда
  db.run(`CREATE TABLE IF NOT EXISTS ingredients (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, unit TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ingredients_name ON ingredients(name)`);
  db.run(`CREATE TABLE IF NOT EXISTS dish_ingredients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dish_id INTEGER NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
    ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    quantity REAL, unit TEXT NOT NULL,
    scaling TEXT NOT NULL DEFAULT 'linear' CHECK (scaling IN ('linear','damped','fixed')),
    note TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_dish_ing_dish ON dish_ingredients(dish_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_dish_ing_ing ON dish_ingredients(ingredient_id)`);
  // шаги отдельной таблицей, пронумерованы; steps_json — зеркало для совместимых ответов API
  db.run(`CREATE TABLE IF NOT EXISTS dish_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dish_id INTEGER NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
    step_no INTEGER NOT NULL, text TEXT NOT NULL, minutes INTEGER
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_dish_steps_dish ON dish_steps(dish_id, step_no)`);
  db.all("PRAGMA table_info(recipes)", [], (eC, colsC) => {
    if (!eC && colsC && !colsC.some(c => c.name === 'category_hint')) db.run("ALTER TABLE recipes ADD COLUMN category_hint TEXT");
  });
  /* v29.1: одна запись веса на аккаунт за день (день = ключ графика; иначе дубли ломают оси) */
  db.run("DELETE FROM weight_logs WHERE id NOT IN (SELECT MIN(id) FROM weight_logs GROUP BY tg_id, date)");
  /* v32: уникальность (tg_id,date) обеспечивает uq_weight_tg_date ниже — второй
     одинаковый UNIQUE-индекс (idx_weight_day) только дублировал его и замедлял запись. */
  db.run(`CREATE TABLE IF NOT EXISTS achievements (
    id INTEGER PRIMARY KEY, title TEXT, description TEXT, icon TEXT,
    condition_type TEXT, condition_value INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS user_achievements (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id TEXT, achievement_id INTEGER,
    unlocked_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // v28: встроенный чат поддержки — сообщения пользователя и ответы поддержки, привязаны к tg_id
  db.run(`CREATE TABLE IF NOT EXISTS support_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id TEXT NOT NULL,
    sender TEXT NOT NULL DEFAULT 'user',
    text TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_support_tg ON support_messages(tg_id)`);

  /* v32: одиночные индексы по tg_id убраны — SQLite берёт их из составных
     (правый/левый префикс): (tg_id,date) и (tg_id,timestamp) покрывают WHERE tg_id = ?.
     EXPLAIN QUERY PLAN подтверждал, что одиночные никогда не выбирались. */
  db.run(`CREATE TABLE IF NOT EXISTS yoga_flows (
    id INTEGER PRIMARY KEY, title TEXT, focus TEXT, level TEXT,
    minutes INTEGER, description TEXT
  )`);
  /* v31: НОВАЯ система программ (Фаза B) — параллельно старым programs/yoga_flows,
     старые таблицы остаются нетронутыми для отката. ids: fit 5001+, йога 5001+. */
  db.run(`CREATE TABLE IF NOT EXISTS fit_programs (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 1, weeks INTEGER NOT NULL DEFAULT 4,
    days_per_week INTEGER NOT NULL DEFAULT 3, minutes INTEGER,
    description TEXT, location TEXT DEFAULT 'home'
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_fit_programs_cat ON fit_programs(category, level)`);
  db.run(`CREATE TABLE IF NOT EXISTS fit_days (
    id INTEGER PRIMARY KEY, program_id INTEGER NOT NULL, week INTEGER NOT NULL,
    day INTEGER NOT NULL, title TEXT, description TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_fit_days_prog ON fit_days(program_id, week, day)`);
  db.run(`CREATE TABLE IF NOT EXISTS fit_exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT, program_day_id INTEGER NOT NULL,
    exercise_id INTEGER NOT NULL, sets INTEGER DEFAULT 3, reps TEXT,
    rest_seconds INTEGER DEFAULT 60, notes TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_fit_ex_day ON fit_exercises(program_day_id)`);
  db.run(`CREATE TABLE IF NOT EXISTS yoga_programs (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, focus TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 1, minutes INTEGER, description TEXT,
    poses TEXT /* JSON: [{pose_id, seconds}] */
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_yoga_programs_level ON yoga_programs(level, focus)`);
  db.run(`CREATE TABLE IF NOT EXISTS yoga_flow_poses (
    id INTEGER PRIMARY KEY AUTOINCREMENT, flow_id INTEGER,
    pose_id INTEGER, seconds INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS yoga_poses (
    id INTEGER PRIMARY KEY, name TEXT, how TEXT, why TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_user_programs_tg ON user_programs(tg_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_workout_sets_log ON workout_sets(log_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_workout_logs_tg_date ON workout_logs(tg_id, date)`);
  /* v32: у water_logs и weight_logs недублирующие индексы по (tg_id,date) не нужны —
     уникальные uq_water_tg_date / uq_weight_tg_date уже индексируют те же колонки. */
  db.run(`CREATE INDEX IF NOT EXISTS idx_food_logs_tg_ts ON food_logs(tg_id, timestamp)`);

  // дедупликация + уникальность на день (защита от гонок параллельных записей)
  db.run(`UPDATE water_logs SET amount_ml = (SELECT SUM(w2.amount_ml) FROM water_logs w2 WHERE w2.tg_id = water_logs.tg_id AND w2.date = water_logs.date) WHERE id IN (SELECT MIN(id) FROM water_logs GROUP BY tg_id, date)`);
  db.run(`DELETE FROM water_logs WHERE id NOT IN (SELECT MIN(id) FROM water_logs GROUP BY tg_id, date)`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_water_tg_date ON water_logs(tg_id, date)`);
  db.run(`DELETE FROM weight_logs WHERE id NOT IN (SELECT MAX(id) FROM weight_logs GROUP BY tg_id, date)`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_weight_tg_date ON weight_logs(tg_id, date)`);
  db.run(`DELETE FROM user_achievements WHERE id NOT IN (SELECT MIN(id) FROM user_achievements GROUP BY tg_id, achievement_id)`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_userach ON user_achievements(tg_id, achievement_id)`);

  /* ═══════════ каталоги из JSON ═══════════
     v25: пересев выполняется ТОЛЬКО если файл-каталог изменился (sha256 в meta).
     Раньше recipes/programs/yoga сносились и вставлялись заново на каждом старте —
     это давало пустой каталог в момент рестарта и рвало связь старых food_logs с рецептами.
     Форсировать пересев можно переменной окружения SEED_FORCE=1. */
  db.run("CREATE TABLE IF NOT EXISTS image_store (recipe_id INTEGER PRIMARY KEY, url TEXT)");

  function fileHash(file) {
    try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16); }
    catch (e) { return null; }
  }
  function seedIfChanged(name, file) {
    if (!fs.existsSync(file)) return;
    const hash = fileHash(file);
    if (!hash) return;
    db.get("SELECT value FROM meta WHERE key = ?", ['seed:' + name], (e, row) => {
      if (e) return console.error('seed meta:', e.message);
      const forced = process.env.SEED_FORCE === '1';
      if (!forced && row && row.value === hash) return; // каталог не менялся
      try {
        seeders[name](() => {
          db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", ['seed:' + name, hash]);
          console.log('Каталог загружен: ' + name + (forced ? ' (SEED_FORCE)' : ''));
        });
      } catch (err) { console.error('seed ' + name + ':', err.message); }
    });
  }

  const seeders = {
    /* v30: легаси-сидер отключён — каталог рецептов теперь ведётся нормализованными таблицами
       (dishes/ingredients/dish_ingredients/dish_steps) и наполняется scripts/import-unitools.js.
       Раньше recipes.json пересеивался при каждом старте и подмешивал шаблонные блюда поверх
       импортированного каталога Unitools. Таблица recipes остаётся зеркалом для совместимости. */
    recipes: function (done) { done(); },
    exercises: function (done) {
      const exercises = JSON.parse(fs.readFileSync('./exercises.json', 'utf8'));
      const stmt = db.prepare(`INSERT INTO exercises
        (id, name, location, type, muscle_group, description, difficulty, sets_default, reps_default, rest_seconds, tips)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, location=excluded.location, type=excluded.type,
          muscle_group=excluded.muscle_group, description=excluded.description,
          difficulty=excluded.difficulty, sets_default=excluded.sets_default,
          reps_default=excluded.reps_default, rest_seconds=excluded.rest_seconds, tips=excluded.tips`);
      exercises.forEach(e => {
        stmt.run(e.id, e.name, e.location, e.type, e.muscle_group,
          e.description, e.difficulty, e.sets_default, e.reps_default, e.rest_seconds, e.tips || '');
      });
      stmt.finalize(() => done());
    },
    programs: function (done) {
      db.serialize(() => {
        db.run("DELETE FROM program_exercises");
        db.run("DELETE FROM program_days");
        db.run("DELETE FROM programs");
        const programs = JSON.parse(fs.readFileSync('./programs.json', 'utf8'));
        const ps = db.prepare(`INSERT OR IGNORE INTO programs
          (id, name, location, type, goal, duration_weeks, description, difficulty)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        programs.forEach(p => ps.run(p.id, p.name, p.location, p.type, p.goal, p.duration_weeks, p.description, p.difficulty));
        ps.finalize();
        let pending = 0, flushing = false;
        programs.forEach(p => {
          if (p.days) p.days.forEach(d => {
            pending++;
            db.run(`INSERT OR IGNORE INTO program_days (id, program_id, week, day, title, description)
              VALUES (?, ?, ?, ?, ?, ?)`, [d.id, p.id, d.week, d.day, d.title, d.description || ''], () => { if (--pending === 0 && flushing) done(); });
            (d.exercises || []).forEach(ex => {
              pending++;
              db.run(`INSERT OR IGNORE INTO program_exercises
                (program_day_id, exercise_id, sets, reps, rest_seconds, notes)
                VALUES (?, ?, ?, ?, ?, ?)`,
                [d.id, ex.exercise_id, ex.sets, ex.reps, ex.rest_seconds, ex.notes || ''], () => { if (--pending === 0 && flushing) done(); });
            });
          });
        });
        flushing = true;
        if (pending === 0) done();
      });
    },
    yoga: function (done) {
      const yg = JSON.parse(fs.readFileSync('./yoga.json', 'utf8'));
      db.serialize(() => {
        db.run("DELETE FROM yoga_flow_poses");
        db.run("DELETE FROM yoga_flows");
        db.run("DELETE FROM yoga_poses");
        const yp = db.prepare(`INSERT INTO yoga_poses (id, name, how, why) VALUES (?, ?, ?, ?)`);
        (yg.poses || []).forEach(p => yp.run(p.id, p.name, p.how, p.why));
        const yf = db.prepare(`INSERT INTO yoga_flows (id, title, focus, level, minutes, description) VALUES (?, ?, ?, ?, ?, ?)`);
        const yfp = db.prepare(`INSERT INTO yoga_flow_poses (flow_id, pose_id, seconds) VALUES (?, ?, ?)`);
        (yg.flows || []).forEach(f => {
          yf.run(f.id, f.title, f.focus, f.level, f.minutes, f.description);
          (f.poses || []).forEach(pp => yfp.run(f.id, pp.pose_id, pp.seconds));
        });
        yp.finalize(); yf.finalize();
        yfp.finalize(() => { console.log('Йога загружена: ' + (yg.flows || []).length + ' практик'); done(); });
      });
    }
  };

  seedIfChanged('recipes', './recipes.json');
  seedIfChanged('exercises', './exercises.json');
  seedIfChanged('programs', './programs.json');
  seedIfChanged('yoga', './yoga.json');

  const achievements = [
    {id:1, title:'Первый шаг', description:'Завершена первая тренировка', icon:'run', condition_type:'workouts', condition_value:1},
    {id:2, title:'Неделя без пропусков', description:'7 дней тренировок подряд', icon:'flame', condition_type:'workout_streak', condition_value:7},
    {id:3, title:'Марафонец', description:'30 завершённых тренировок', icon:'trophy', condition_type:'workouts', condition_value:30},
    {id:4, title:'Водный баланс', description:'7 дней нормы воды подряд', icon:'droplet', condition_type:'water_streak', condition_value:7},
    {id:5, title:'Кулинар', description:'Записано 50 блюд в дневник', icon:'chef', condition_type:'meals', condition_value:50},
    {id:6, title:'Силач', description:'Общий объём тренировок 10000 кг', icon:'dumbbell', condition_type:'volume', condition_value:10000}
  ];
  const as = db.prepare(`INSERT OR IGNORE INTO achievements (id, title, description, icon, condition_type, condition_value) VALUES (?, ?, ?, ?, ?, ?)`);
  achievements.forEach(a => as.run(a.id, a.title, a.description, a.icon, a.condition_type, a.condition_value));
  as.finalize();
  // миграция иконок со старых эмодзи на SVG-ключи фронта (идемпотентно)
  db.run(`UPDATE achievements SET icon = CASE id WHEN 1 THEN 'run' WHEN 2 THEN 'flame' WHEN 3 THEN 'trophy' WHEN 4 THEN 'droplet' WHEN 5 THEN 'chef' WHEN 6 THEN 'dumbbell' ELSE icon END WHERE icon NOT IN ('run','flame','trophy','droplet','chef','dumbbell')`);
});

module.exports = db;
