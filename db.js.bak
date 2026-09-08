const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./guidefit.db');
const fs = require('fs');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    tg_id TEXT PRIMARY KEY,
    name TEXT,
    goal TEXT,
    gender TEXT,
    age INTEGER,
    height INTEGER,
    current_weight REAL,
    target_weight REAL,
    calorie_norm INTEGER,
    activity_level TEXT DEFAULT 'moderate',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS food_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id TEXT,
    recipe_id INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY,
    title TEXT,
    category TEXT,
    calories INTEGER,
    protein INTEGER,
    fat INTEGER,
    carbs INTEGER,
    description TEXT,
    benefits TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS exercises (
    id INTEGER PRIMARY KEY,
    name TEXT,
    location TEXT,
    type TEXT,
    muscle_group TEXT,
    description TEXT,
    difficulty TEXT,
    sets_default INTEGER,
    reps_default TEXT,
    rest_seconds INTEGER,
    tips TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS programs (
    id INTEGER PRIMARY KEY,
    name TEXT,
    location TEXT,
    type TEXT,
    goal TEXT,
    duration_weeks INTEGER,
    description TEXT,
    difficulty TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS program_days (
    id INTEGER PRIMARY KEY,
    program_id INTEGER,
    week INTEGER,
    day INTEGER,
    title TEXT,
    description TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS program_exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    program_day_id INTEGER,
    exercise_id INTEGER,
    sets INTEGER,
    reps TEXT,
    rest_seconds INTEGER,
    notes TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS user_programs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id TEXT,
    program_id INTEGER,
    start_date TEXT,
    current_week INTEGER DEFAULT 1,
    current_day INTEGER DEFAULT 1,
    active INTEGER DEFAULT 1,
    completed INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS workout_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id TEXT,
    program_id INTEGER,
    program_day_id INTEGER,
    date TEXT,
    duration_minutes INTEGER,
    total_volume REAL,
    notes TEXT,
    completed INTEGER DEFAULT 1
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS workout_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_id INTEGER,
    exercise_id INTEGER,
    set_number INTEGER,
    reps INTEGER,
    weight REAL,
    completed INTEGER DEFAULT 1
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS water_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id TEXT,
    date TEXT,
    amount_ml INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS weight_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id TEXT,
    date TEXT,
    weight REAL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS achievements (
    id INTEGER PRIMARY KEY,
    title TEXT,
    description TEXT,
    icon TEXT,
    condition_type TEXT,
    condition_value INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS user_achievements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id TEXT,
    achievement_id INTEGER,
    unlocked_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  if (fs.existsSync('./recipes.json')) {
    const recipes = JSON.parse(fs.readFileSync('./recipes.json', 'utf8'));
    const stmt = db.prepare(`INSERT OR IGNORE INTO recipes 
      (id, title, category, calories, protein, fat, carbs, description, benefits) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    recipes.forEach(r => {
      stmt.run(r.id, r.title, r.category, r.calories, r.protein, 
        r.fat, r.carbs, r.description || '', r.benefits || '');
    });
    stmt.finalize();
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

  if (fs.existsSync('./programs.json')) {
    const programs = JSON.parse(fs.readFileSync('./programs.json', 'utf8'));
    const progStmt = db.prepare(`INSERT OR IGNORE INTO programs 
      (id, name, location, type, goal, duration_weeks, description, difficulty) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    programs.forEach(p => {
      progStmt.run(p.id, p.name, p.location, p.type, p.goal, p.duration_weeks, p.description, p.difficulty);
    });
    progStmt.finalize();

    programs.forEach(p => {
      if (p.days) {
        p.days.forEach(d => {
          db.run(`INSERT OR IGNORE INTO program_days (id, program_id, week, day, title, description) 
            VALUES (?, ?, ?, ?, ?, ?)`,
            [d.id, p.id, d.week, d.day, d.title, d.description || '']);
          
          if (d.exercises) {
            d.exercises.forEach(ex => {
              db.run(`INSERT OR IGNORE INTO program_exercises 
                (program_day_id, exercise_id, sets, reps, rest_seconds, notes) 
                VALUES (?, ?, ?, ?, ?, ?)`,
                [d.id, ex.exercise_id, ex.sets, ex.reps, ex.rest_seconds, ex.notes || '']);
            });
          }
        });
      }
    });
  }

  const achievements = [
    {id: 1, title: 'Первый шаг', description: 'Завершена первая тренировка', icon: '🏃', condition_type: 'workouts', condition_value: 1},
    {id: 2, title: 'Неделя без пропусков', description: '7 дней тренировок подряд', icon: '🔥', condition_type: 'workout_streak', condition_value: 7},
    {id: 3, title: 'Марафонец', description: '30 завершённых тренировок', icon: '🏆', condition_type: 'workouts', condition_value: 30},
    {id: 4, title: 'Водный баланс', description: '7 дней нормы воды подряд', icon: '💧', condition_type: 'water_streak', condition_value: 7},
    {id: 5, title: 'Кулинар', description: 'Записано 50 блюд в дневник', icon: '🍳', condition_type: 'meals', condition_value: 50},
    {id: 6, title: 'Силач', description: 'Общий объём тренировок 10000 кг', icon: '💪', condition_type: 'volume', condition_value: 10000}
  ];
  const achStmt = db.prepare(`INSERT OR IGNORE INTO achievements (id, title, description, icon, condition_type, condition_value) VALUES (?, ?, ?, ?, ?, ?)`);
  achievements.forEach(a => achStmt.run(a.id, a.title, a.description, a.icon, a.condition_type, a.condition_value));
  achStmt.finalize();
});

module.exports = db;
