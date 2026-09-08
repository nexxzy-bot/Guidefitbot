// server.js
const express = require('express');
require('dotenv').config();
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.static('static'));

// Middleware to ensure all /api/ responses are JSON
app.use('/api/', (req, res, next) => {
    res.type('json');
    next();
});

// Get dashboard stats
app.post('/api/dashboard', (req, res) => {
    const { tg_id } = req.body;
    if (!tg_id) return res.status(400).json({ error: 'Missing tg_id' });
    
    db.get("SELECT goal, calorie_norm FROM users WHERE tg_id = ?", [tg_id], (err, user) => {
        if (err) {
            console.error("DB error:", err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        const consumption = { calories: 1200, protein: 50, fat: 30, carbs: 100 };
        const norms = { calories: user ? user.calorie_norm || 2000 : 2000, protein: 150, fat: 70, carbs: 250 };
        
        res.json({ streak: 1, consumption, norms });
    });
});

app.post('/api/save-goal', (req, res) => {
    const { tg_id, goal } = req.body;
    if (!tg_id || !goal) return res.status(400).json({ error: 'Missing fields' });
    db.run("INSERT OR REPLACE INTO users (tg_id, goal) VALUES (?, ?)", [tg_id, goal], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: 'ok' });
    });
});

app.post('/api/get-meal', (req, res) => {
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

app.listen(process.env.MINIAPP_PORT || 3000, () => {
    console.log(`GuideFit server started on port ${process.env.MINIAPP_PORT || 3000}`);
});
