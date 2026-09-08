// db.js
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./guidefit.db');
const fs = require('fs');

db.serialize(() => {
  // GuideFit tables
  db.run("CREATE TABLE IF NOT EXISTS users (tg_id INTEGER PRIMARY KEY, goal TEXT, calorie_norm INTEGER)");
  db.run("CREATE TABLE IF NOT EXISTS food_logs (id INTEGER PRIMARY KEY, tg_id INTEGER, recipe_id INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  
  // Recipes table
  db.run(`CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY,
    title TEXT,
    category TEXT,
    calories INTEGER,
    protein INTEGER,
    fat INTEGER,
    carbs INTEGER,
    description TEXT
  )`);

  // Seed recipes
  const recipes = JSON.parse(fs.readFileSync('./recipes.json', 'utf8'));
  const stmt = db.prepare("INSERT OR IGNORE INTO recipes VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  recipes.forEach(r => {
    stmt.run(r.id, r.title, r.category, r.calories, r.protein, r.fat, r.carbs, r.description);
  });
  stmt.finalize();
});

module.exports = db;
