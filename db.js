const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./guidefit.db');
const fs = require('fs');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    tg_id TEXT PRIMARY KEY, name TEXT, goal TEXT, gender TEXT,
    age INTEGER, height INTEGER, current_weight REAL, target_weight REAL,
    calorie_norm INTEGER, activity_level TEXT DEFAULT 'moderate',
    meal_count INTEGER DEFAULT 4, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, tg_id TEXT, created_at INTEGER
  )`);
  db.all("PRAGMA table_info(users)", [], (e2, cols2) => {
    if (!e2 && cols2 && !cols2.some(c => c.name === 'notify_enabled')) db.run("ALTER TABLE users ADD COLUMN notify_enabled INTEGER DEFAULT 1");
  });
  // админка + мультиавторизация (ВК/Яндекс/Max): последний визит и провайдер (tg_id остаётся единым subject: 'tg:123', 'vk:456', ...)
  // + фото профиля из VK (avatar)
  db.all("PRAGMA table_info(users)", [], (e3, cols3) => {
    if (!e3 && cols3) {
      if (!cols3.some(c => c.name === 'last_seen')) db.run("ALTER TABLE users ADD COLUMN last_seen DATETIME");
      if (!cols3.some(c => c.name === 'provider')) db.run("ALTER TABLE users ADD COLUMN provider TEXT DEFAULT 'tg'");
      if (!cols3.some(c => c.name === 'avatar')) db.run("ALTER TABLE users ADD COLUMN avatar TEXT");
    }
  });
  db.run(`CREATE TABLE IF NOT EXISTS food_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id TEXT, recipe_id INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY, title TEXT, category TEXT,
    calories REAL, protein REAL, fat REAL, carbs REAL,
    description TEXT, benefits TEXT, ingredients TEXT,
    recipe_steps TEXT, image_url TEXT, goals TEXT
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

  // v9: каталог рецептов пересобирается при каждом старте
  db.run("CREATE TABLE IF NOT EXISTS image_store (recipe_id INTEGER PRIMARY KEY, url TEXT)");
  db.run("INSERT OR REPLACE INTO image_store (recipe_id, url) SELECT id, image_url FROM recipes WHERE image_url IS NOT NULL AND image_url != ''");
  db.run("DELETE FROM recipes");
  if (fs.existsSync('./recipes.json')) {
    const recipes = JSON.parse(fs.readFileSync('./recipes.json', 'utf8'));
    const stmt = db.prepare(`INSERT OR IGNORE INTO recipes
      (id, title, category, calories, protein, fat, carbs, description, benefits, ingredients, recipe_steps, image_url, goals, photo_query)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    recipes.forEach(r => {
      const title = r.title || r.name || '';
      const steps = r.recipe_steps || r.steps || [];
      stmt.run(r.id, title, r.category, r.calories || 0, r.protein || 0,
        r.fat || 0, r.carbs || 0, r.description || '', r.benefits || '',
        JSON.stringify(r.ingredients || []), JSON.stringify(steps),
        r.image_url || '', JSON.stringify(r.goals || ['lose','gain','maintain']), r.photo || '');
    });
    stmt.finalize();
    // восстанавливаем закэшированные URL (включая локальные /images/...) поверх пересева:
    // локальный файл всегда побеждает (это обработанный артефакт), remote из JSON — только для новых id
    db.run(`UPDATE recipes SET image_url = (SELECT url FROM image_store WHERE image_store.recipe_id = recipes.id) WHERE EXISTS (SELECT 1 FROM image_store WHERE image_store.recipe_id = recipes.id AND url IS NOT NULL AND url != '' AND ((recipes.image_url IS NULL OR recipes.image_url = '' OR recipes.image_url = 'empty.jpg') OR image_store.url LIKE '/images/%'))`);
  }
  if (fs.existsSync('./exercises.json')) {
    const exercises = JSON.parse(fs.readFileSync('./exercises.json', 'utf8'));
    const stmt = db.prepare(`INSERT OR IGNORE INTO exercises
      (id, name, location, type, muscle_group, description, difficulty, sets_default, reps_default, rest_seconds, tips)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    exercises.forEach(e => {
      stmt.run(e.id, e.name, e.location, e.type, e.muscle_group,
        e.description, e.difficulty, e.sets_default, e.reps_default, e.rest_seconds, e.tips || '');
    });
    stmt.finalize();
  }
  // v8: каталог программ пересобирается при каждом старте (история тренировок сохраняется)
  db.run("DELETE FROM program_exercises");
  db.run("DELETE FROM program_days");
  db.run("DELETE FROM programs");
  // v14: прогресс пользователей сохраняем при рестарте (аудит)
  if (fs.existsSync('./programs.json')) {
    const programs = JSON.parse(fs.readFileSync('./programs.json', 'utf8'));
    const ps = db.prepare(`INSERT OR IGNORE INTO programs
      (id, name, location, type, goal, duration_weeks, description, difficulty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    programs.forEach(p => ps.run(p.id, p.name, p.location, p.type, p.goal, p.duration_weeks, p.description, p.difficulty));
    ps.finalize();
    programs.forEach(p => {
      if (p.days) p.days.forEach(d => {
        db.run(`INSERT OR IGNORE INTO program_days (id, program_id, week, day, title, description)
          VALUES (?, ?, ?, ?, ?, ?)`, [d.id, p.id, d.week, d.day, d.title, d.description || '']);
        if (d.exercises) d.exercises.forEach(ex => {
          db.run(`INSERT OR IGNORE INTO program_exercises
            (program_day_id, exercise_id, sets, reps, rest_seconds, notes)
            VALUES (?, ?, ?, ?, ?, ?)`,
            [d.id, ex.exercise_id, ex.sets, ex.reps, ex.rest_seconds, ex.notes || '']);
        });
      });
    });
  }

  if (fs.existsSync('./yoga.json')) {
    const yg = JSON.parse(fs.readFileSync('./yoga.json', 'utf8'));
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
    yp.finalize(); yf.finalize(); yfp.finalize();
    console.log('Йога загружена: ' + yg.flows.length + ' практик');
  }
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
