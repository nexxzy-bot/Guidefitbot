const express = require('express');
require('dotenv').config();
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.static('static'));

app.use('/api/', (req, res, next) => {
    res.type('json');
    next();
});

app.post('/api/user/init', (req, res) => {
    const { tg_id, name, goal, gender, age, height, current_weight, target_weight } = req.body;
    if (!tg_id || !name || !goal || !gender || !age || !height || !current_weight) {
        return res.status(400).json({ error: 'Missing fields' });
    }
    let bmr = 10 * current_weight + 6.25 * height - 5 * age;
    bmr += gender === 'male' ? 5 : -161;
    let calorie_norm = Math.round(bmr * 1.375);
    if (goal === 'lose') calorie_norm -= 500;
    if (goal === 'gain') calorie_norm += 500;
    db.run(
        `INSERT OR REPLACE INTO users 
         (tg_id, name, goal, gender, age, height, current_weight, target_weight, calorie_norm) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tg_id, name, goal, gender, age, height, current_weight, target_weight || current_weight, calorie_norm],
        (err) => {
            if (err) { console.error(err); return res.status(500).json({ error: 'Database error' }); }
            res.json({ status: 'ok', calorie_norm });
        }
    );
});

app.get('/api/user/:tgId', (req, res) => {
    db.get("SELECT * FROM users WHERE tg_id = ?", [req.params.tgId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'User not found' });
        res.json(row);
    });
});

app.post('/api/user/update', (req, res) => {
    const { tg_id, current_weight, target_weight, goal } = req.body;
    if (!tg_id) return res.status(400).json({ error: 'Missing tg_id' });
    db.get("SELECT age, height, gender FROM users WHERE tg_id = ?", [tg_id], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'User not found' });
        let bmr = 10 * current_weight + 6.25 * user.height - 5 * user.age;
        bmr += user.gender === 'male' ? 5 : -161;
        let calorie_norm = Math.round(bmr * 1.375);
        if (goal === 'lose') calorie_norm -= 500;
        if (goal === 'gain') calorie_norm += 500;
        db.run(
            "UPDATE users SET current_weight = ?, target_weight = ?, goal = ?, calorie_norm = ? WHERE tg_id = ?",
            [current_weight, target_weight, goal, calorie_norm, tg_id],
            (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ status: 'ok', calorie_norm });
            }
        );
    });
});

app.post('/api/dashboard', (req, res) => {
    const { tg_id } = req.body;
    if (!tg_id) return res.status(400).json({ error: 'Missing tg_id' });
    db.get("SELECT name, goal, calorie_norm FROM users WHERE tg_id = ?", [tg_id], (err, user) => {
        if (err) { console.error("DB error:", err); return res.status(500).json({ error: 'Database error' }); }
        if (!user) return res.status(404).json({ error: 'User not found' });
        const consumption = { calories: 1200, protein: 50, fat: 30, carbs: 100 };
        const norms = { calories: user.calorie_norm || 2000, protein: 150, fat: 70, carbs: 250 };
        const hour = new Date().getHours();
        let nextMeal = 'breakfast';
        if (hour >= 10) nextMeal = 'lunch';
        if (hour >= 15) nextMeal = 'snack';
        if (hour >= 18) nextMeal = 'dinner';
        res.json({ streak: 1, consumption, norms, user, nextMeal, mealsToday: 0 });
    });
});

app.post('/api/meal', (req, res) => {
    const { category } = req.body;
    if (!category) return res.status(400).json({ error: 'Missing category' });
    db.get("SELECT * FROM recipes WHERE category = ? ORDER BY RANDOM() LIMIT 1", [category], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Recipe not found' });
        res.json({ recipe: row });
    });
});

app.post('/api/log-meal', (req, res) => {
    const { tg_id, recipe_id } = req.body;
    if (!tg_id || !recipe_id) return res.status(400).json({ error: 'Missing fields' });
    db.run("INSERT INTO food_logs (tg_id, recipe_id) VALUES (?, ?)", [tg_id, recipe_id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: 'ok' });
    });
});

app.get('/api/food-log/today/:tgId', (req, res) => {
    const tgId = req.params.tgId;
    const today = new Date().toISOString().split('T')[0];
    db.all(`
        SELECT r.*, fl.timestamp 
        FROM food_logs fl
        JOIN recipes r ON fl.recipe_id = r.id
        WHERE fl.tg_id = ? AND date(fl.timestamp) = ?
        ORDER BY fl.timestamp DESC
    `, [tgId, today], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ meals: rows || [] });
    });
});

app.listen(process.env.MINIAPP_PORT || 3000, () => {
    console.log(`GuideFit server started on port ${process.env.MINIAPP_PORT || 3000}`);
});
