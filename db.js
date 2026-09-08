const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./guidefit.db');
const fs = require('fs');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    tg_id INTEGER PRIMARY KEY,
    name TEXT,
    goal TEXT,
    gender TEXT,
    age INTEGER,
    height INTEGER,
    current_weight REAL,
    target_weight REAL,
    calorie_norm INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS food_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id INTEGER,
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

  if (fs.existsSync('./recipes.json')) {
    const recipes = JSON.parse(fs.readFileSync('./recipes.json', 'utf8'));
    const stmt = db.prepare(`INSERT OR IGNORE INTO recipes 
      (id, title, category, calories, protein, fat, carbs, description, benefits) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    recipes.forEach(r => {
      stmt.run(
        r.id, r.title, r.category, r.calories, r.protein, 
        r.fat, r.carbs, r.description || '', r.benefits || ''
      );
    });
    stmt.finalize();
  }
});

module.exports = db;
