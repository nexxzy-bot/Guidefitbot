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
  // notify_chat_id — привязанный Telegram-чат (напоминания для ВК/анонимных аккаунтов).
  db.run(`CREATE TABLE IF NOT EXISTS users (
    tg_id TEXT PRIMARY KEY, name TEXT, goal TEXT, gender TEXT,
    age INTEGER, height INTEGER, current_weight REAL, target_weight REAL,
    calorie_norm INTEGER, activity_level TEXT DEFAULT 'moderate',
    meal_count INTEGER DEFAULT 4, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    notify_enabled INTEGER DEFAULT 1, last_seen DATETIME,
    provider TEXT DEFAULT 'tg', avatar TEXT, notify_chat_id TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, tg_id TEXT, created_at INTEGER
  )`);
  db.all("PRAGMA table_info(users)", [], (e2, cols2) => {
    if (!e2 && cols2 && !cols2.some(c => c.name === 'notify_enabled')) db.run("ALTER TABLE users ADD COLUMN notify_enabled INTEGER DEFAULT 1");
  });
  // админка + мультиавторизация (ВК/Яндекс/Max): последний визит и провайдер (tg_id остаётся единым subject: 'tg:123', 'vk:456', ...)
  // + фото профиля из VK (avatar) + привязанный Telegram-чат для напоминаний (notify_chat_id)
  db.all("PRAGMA table_info(users)", [], (e3, cols3) => {
    if (!e3 && cols3) {
      if (!cols3.some(c => c.name === 'last_seen')) db.run("ALTER TABLE users ADD COLUMN last_seen DATETIME");
      if (!cols3.some(c => c.name === 'provider')) db.run("ALTER TABLE users ADD COLUMN provider TEXT DEFAULT 'tg'");
      if (!cols3.some(c => c.name === 'avatar')) db.run("ALTER TABLE users ADD COLUMN avatar TEXT");
      if (!cols3.some(c => c.name === 'notify_chat_id')) db.run("ALTER TABLE users ADD COLUMN notify_chat_id TEXT");
    }
  });
  // одноразовые коды привязки Telegram-чата к аккаунту ВК/анонимному (вводятся боту командой /start link_<code>)
  db.run(`CREATE TABLE IF NOT EXISTS link_codes (
    code TEXT PRIMARY KEY, tg_id TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_link_codes_tg ON link_codes(tg_id)`);
  // служебные метаданные (например, хэш каталогов — чтобы не пересевать БД на каждом старте)
  db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS food_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id TEXT, recipe_id INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
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
  db.run(`CREATE TABLE IF NOT EXISTS achievements (
    id INTEGER PRIMARY KEY, title TEXT, description TEXT, icon TEXT,
    condition_type TEXT, condition_value INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS user_achievements (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id TEXT, achievement_id INTEGER,
    unlocked_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS notification_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id TEXT NOT NULL, type TEXT NOT NULL, date TEXT NOT NULL,
    UNIQUE(tg_id, type, date)
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_food_logs_tg ON food_logs(tg_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_workout_logs_tg ON workout_logs(tg_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_water_logs_tg ON water_logs(tg_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_weight_logs_tg ON weight_logs(tg_id)`);
  db.run(`CREATE TABLE IF NOT EXISTS yoga_flows (
    id INTEGER PRIMARY KEY, title TEXT, focus TEXT, level TEXT,
    minutes INTEGER, description TEXT
  )`);
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
  db.run(`CREATE INDEX IF NOT EXISTS idx_water_logs_tg_date ON water_logs(tg_id, date)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_weight_logs_tg_date ON weight_logs(tg_id, date)`);
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
    recipes: function (done) {
      db.run("INSERT OR REPLACE INTO image_store (recipe_id, url) SELECT id, image_url FROM recipes WHERE image_url IS NOT NULL AND image_url != ''");
      const recipes = JSON.parse(fs.readFileSync('./recipes.json', 'utf8'));
      // UPSERT вместо DELETE+INSERT: id остаются теми же, старые записи дневника не теряют блюдо
      const stmt = db.prepare(`INSERT INTO recipes
        (id, title, category, calories, protein, fat, carbs, description, benefits, ingredients, recipe_steps, image_url, goals, photo_query)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title=excluded.title, category=excluded.category, calories=excluded.calories,
          protein=excluded.protein, fat=excluded.fat, carbs=excluded.carbs,
          description=excluded.description, benefits=excluded.benefits,
          ingredients=excluded.ingredients, recipe_steps=excluded.recipe_steps,
          image_url=excluded.image_url, goals=excluded.goals, photo_query=excluded.photo_query`);
      recipes.forEach(r => {
        const title = r.title || r.name || '';
        const steps = r.recipe_steps || r.steps || [];
        stmt.run(r.id, title, r.category, r.calories || 0, r.protein || 0,
          r.fat || 0, r.carbs || 0, r.description || '', r.benefits || '',
          JSON.stringify(r.ingredients || []), JSON.stringify(steps),
          r.image_url || '', JSON.stringify(r.goals || ['lose','gain','maintain']), r.photo || '');
      });
      stmt.finalize(() => {
        // восстанавливаем закэшированные URL (включая локальные /images/...):
        // локальный файл всегда побеждает (это обработанный артефакт), remote из JSON — только для новых id
        db.run(`UPDATE recipes SET image_url = (SELECT url FROM image_store WHERE image_store.recipe_id = recipes.id) WHERE EXISTS (SELECT 1 FROM image_store WHERE image_store.recipe_id = recipes.id AND url IS NOT NULL AND url != '' AND ((recipes.image_url IS NULL OR recipes.image_url = '' OR recipes.image_url = 'empty.jpg') OR image_store.url LIKE '/images/%'))`, [], () => done());
      });
    },
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
