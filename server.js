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

const ACTIVITY_MULTIPLIERS = {
    sedentary: 1.2,
    light: 1.375,
    moderate: 1.55,
    active: 1.725,
    very_active: 1.9
};

function calcCalories(current_weight, height, age, gender, activity_level, goal) {
    let bmr = 10 * current_weight + 6.25 * height - 5 * age;
    bmr += gender === 'male' ? 5 : -161;
    const mult = ACTIVITY_MULTIPLIERS[activity_level] || 1.375;
    let norm = Math.round(bmr * mult);
    if (goal === 'lose') norm -= 500;
    if (goal === 'gain') norm += 500;
    return norm;
}

app.post('/api/user/init', (req, res) => {
    const { tg_id, name, goal, gender, age, height, current_weight, target_weight, activity_level } = req.body;
    if (!tg_id || !name || !goal || !gender || !age || !height || !current_weight) {
        return res.status(400).json({ error: 'Missing fields' });
    }
    const calorie_norm = calcCalories(current_weight, height, age, gender, activity_level || 'moderate', goal);
    db.run(
        `INSERT OR REPLACE INTO users 
         (tg_id, name, goal, gender, age, height, current_weight, target_weight, calorie_norm, activity_level) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tg_id, name, goal, gender, age, height, current_weight, target_weight || current_weight, calorie_norm, activity_level || 'moderate'],
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
    const { tg_id, current_weight, target_weight, goal, activity_level } = req.body;
    if (!tg_id) return res.status(400).json({ error: 'Missing tg_id' });
    db.get("SELECT age, height, gender, activity_level as al FROM users WHERE tg_id = ?", [tg_id], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'User not found' });
        const al = activity_level || user.al || 'moderate';
        const calorie_norm = calcCalories(current_weight, user.height, user.age, user.gender, al, goal);
        db.run(
            "UPDATE users SET current_weight = ?, target_weight = ?, goal = ?, calorie_norm = ?, activity_level = ? WHERE tg_id = ?",
            [current_weight, target_weight, goal, calorie_norm, al, tg_id],
            (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ status: 'ok', calorie_norm });
            }
        );
    });
});

function calcStreak(tg_id, callback) {
    db.all("SELECT date FROM workout_logs WHERE tg_id = ? ORDER BY date DESC", [tg_id], (err, rows) => {
        if (err || !rows.length) return callback(0);
        const dates = [...new Set(rows.map(r => r.date))].sort().reverse();
        let streak = 1;
        const today = new Date().toISOString().split('T')[0];
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        if (dates[0] !== today && dates[0] !== yesterday) return callback(0);
        for (let i = 1; i < dates.length; i++) {
            const prev = new Date(dates[i-1]);
            const curr = new Date(dates[i]);
            const diff = (prev - curr) / 86400000;
            if (diff === 1) streak++;
            else break;
        }
        callback(streak);
    });
}

app.post('/api/dashboard', (req, res) => {
    const { tg_id } = req.body;
    if (!tg_id) return res.status(400).json({ error: 'Missing tg_id' });
    
    db.get("SELECT name, goal, calorie_norm FROM users WHERE tg_id = ?", [tg_id], (err, user) => {
        if (err) { console.error("DB error:", err); return res.status(500).json({ error: 'Database error' }); }
        if (!user) return res.status(404).json({ error: 'User not found' });

        const today = new Date().toISOString().split('T')[0];
        
        db.all(`SELECT r.* FROM food_logs fl JOIN recipes r ON fl.recipe_id = r.id 
            WHERE fl.tg_id = ? AND date(fl.timestamp) = ?`, [tg_id, today], (err, meals) => {
            
            let consumption = { calories: 0, protein: 0, fat: 0, carbs: 0 };
            meals.forEach(m => {
                consumption.calories += m.calories;
                consumption.protein += m.protein;
                consumption.fat += m.fat;
                consumption.carbs += m.carbs;
            });

            db.get("SELECT amount_ml FROM water_logs WHERE tg_id = ? AND date = ?", [tg_id, today], (err, water) => {
                const waterAmount = water ? water.amount_ml : 0;

                db.get("SELECT COUNT(*) as count FROM workout_logs WHERE tg_id = ? AND date = ?", [tg_id, today], (err, workout) => {
                    const hasWorkout = workout && workout.count > 0;

                    db.get(`SELECT p.*, up.current_week, up.current_day, up.start_date 
                        FROM user_programs up JOIN programs p ON up.program_id = p.id 
                        WHERE up.tg_id = ? AND up.active = 1`, [tg_id], (err, program) => {

                        const norms = { calories: user.calorie_norm || 2000, protein: 150, fat: 70, carbs: 250 };
                        const hour = new Date().getHours();
                        let nextMeal = 'breakfast';
                        if (hour >= 10) nextMeal = 'lunch';
                        if (hour >= 15) nextMeal = 'snack';
                        if (hour >= 18) nextMeal = 'dinner';

                        calcStreak(tg_id, (streak) => {
                            res.json({ 
                                streak, 
                                consumption, 
                                norms, 
                                user,
                                nextMeal,
                                mealsToday: meals.length,
                                water: waterAmount,
                                hasWorkout: !!hasWorkout,
                                activeProgram: program || null
                            });
                        });
                    });
                });
            });
        });
    });
});

app.post('/api/meal', (req, res) => {
    const { category, goal, exclude_id } = req.body;
    if (!category) return res.status(400).json({ error: 'Missing category' });
    let sql = "SELECT * FROM recipes WHERE category = ?";
    let params = [category];
    if (goal) {
        sql += " AND (goals LIKE ? OR goals IS NULL OR goals = '')";
        params.push('%' + goal + '%');
    }
    if (exclude_id) {
        sql += " AND id != ?";
        params.push(exclude_id);
    }
    sql += " ORDER BY RANDOM() LIMIT 1";
    db.get(sql, params, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Recipe not found' });
        if (row.ingredients) try { row.ingredients = JSON.parse(row.ingredients); } catch(e){}
        if (row.recipe_steps) try { row.recipe_steps = JSON.parse(row.recipe_steps); } catch(e){}
        if (row.goals) try { row.goals = JSON.parse(row.goals); } catch(e){ row.goals = [row.goals]; }
        res.json({ recipe: row });
    });
});

app.get('/api/recipe/:id', (req, res) => {
    db.get("SELECT * FROM recipes WHERE id = ?", [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Not found' });
        if (row.ingredients) try { row.ingredients = JSON.parse(row.ingredients); } catch(e){}
        if (row.recipe_steps) try { row.recipe_steps = JSON.parse(row.recipe_steps); } catch(e){}
        res.json(row);
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

app.delete('/api/food-log/:id', (req, res) => {
    const tg_id = req.query.tg_id;
    if (!tg_id) return res.status(400).json({ error: 'Missing tg_id' });
    db.run("DELETE FROM food_logs WHERE id = ? AND tg_id = ?", [req.params.id, tg_id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: 'ok', deleted: this.changes });
    });
});

app.get('/api/food-log/today/:tgId', (req, res) => {
    const tgId = req.params.tgId;
    const today = new Date().toISOString().split('T')[0];
    db.all(`
        SELECT fl.id as log_id, r.*, fl.timestamp 
        FROM food_logs fl
        JOIN recipes r ON fl.recipe_id = r.id
        WHERE fl.tg_id = ? AND date(fl.timestamp) = ?
        ORDER BY fl.timestamp DESC
    `, [tgId, today], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ meals: rows || [] });
    });
});

app.get('/api/shopping-list/:tgId', (req, res) => {
    const tgId = req.params.tgId;
    const weekAgo = new Date(Date.now() - 7*86400000).toISOString().split('T')[0];
    db.all(`
        SELECT r.ingredients FROM food_logs fl
        JOIN recipes r ON fl.recipe_id = r.id
        WHERE fl.tg_id = ? AND date(fl.timestamp) >= ?
    `, [tgId, weekAgo], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const items = new Set();
        rows.forEach(r => {
            let ings = [];
            try { ings = JSON.parse(r.ingredients); } catch(e) {}
            ings.forEach(i => items.add(i));
        });
        res.json({ items: Array.from(items) });
    });
});

app.get('/api/weekly-report/:tgId', (req, res) => {
    const tgId = req.params.tgId;
    const weekAgo = new Date(Date.now() - 7*86400000).toISOString().split('T')[0];
    
    db.all("SELECT date, duration_minutes, total_volume FROM workout_logs WHERE tg_id = ? AND date >= ? ORDER BY date", [tgId, weekAgo], (err, workouts) => {
        if (err) return res.status(500).json({ error: err.message });
        
        db.all("SELECT date, weight FROM weight_logs WHERE tg_id = ? AND date >= ? ORDER BY date", [tgId, weekAgo], (err, weights) => {
            if (err) return res.status(500).json({ error: err.message });
            
            db.all(`SELECT r.calories, r.protein, r.fat, r.carbs FROM food_logs fl JOIN recipes r ON fl.recipe_id = r.id WHERE fl.tg_id = ? AND date(fl.timestamp) >= ?`, [tgId, weekAgo], (err, meals) => {
                if (err) return res.status(500).json({ error: err.message });
                
                const totalWorkouts = workouts.length;
                const totalMinutes = workouts.reduce((s, w) => s + (w.duration_minutes || 0), 0);
                const totalVolume = workouts.reduce((s, w) => s + (w.total_volume || 0), 0);
                const avgCals = meals.length ? Math.round(meals.reduce((s, m) => s + m.calories, 0) / 7) : 0;
                const weightChange = weights.length >= 2 ? (weights[weights.length-1].weight - weights[0].weight).toFixed(1) : 0;
                
                res.json({
                    totalWorkouts,
                    totalMinutes,
                    totalVolume,
                    avgCalories: avgCals,
                    weightChange,
                    weightFirst: weights.length ? weights[0].weight : null,
                    weightLast: weights.length ? weights[weights.length-1].weight : null
                });
            });
        });
    });
});

app.get('/api/exercises', (req, res) => {
    const { location, type, muscle } = req.query;
    let sql = "SELECT * FROM exercises WHERE 1=1";
    let params = [];
    if (location) { sql += " AND location = ?"; params.push(location); }
    if (type) { sql += " AND type = ?"; params.push(type); }
    if (muscle) { sql += " AND muscle_group = ?"; params.push(muscle); }
    sql += " ORDER BY name";
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ exercises: rows });
    });
});

app.get('/api/exercise/:id', (req, res) => {
    db.get("SELECT * FROM exercises WHERE id = ?", [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Not found' });
        res.json(row);
    });
});

app.get('/api/programs', (req, res) => {
    const { location, type, goal } = req.query;
    let sql = "SELECT * FROM programs WHERE 1=1";
    let params = [];
    if (location) { sql += " AND location = ?"; params.push(location); }
    if (type) { sql += " AND type = ?"; params.push(type); }
    if (goal) { sql += " AND goal = ?"; params.push(goal); }
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ programs: rows });
    });
});

app.get('/api/program/:id', (req, res) => {
    db.get("SELECT * FROM programs WHERE id = ?", [req.params.id], (err, program) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!program) return res.status(404).json({ error: 'Not found' });
        
        db.all("SELECT * FROM program_days WHERE program_id = ? ORDER BY week, day", [req.params.id], (err, days) => {
            if (err) return res.status(500).json({ error: err.message });
            
            const fetchExercises = (index) => {
                if (index >= days.length) {
                    res.json({ program, days, totalDays: days.length });
                    return;
                }
                db.all(`SELECT pe.*, e.name as exercise_name, e.muscle_group, e.description as exercise_desc 
                    FROM program_exercises pe 
                    JOIN exercises e ON pe.exercise_id = e.id 
                    WHERE pe.program_day_id = ?`, [days[index].id], (err, exes) => {
                    days[index].exercises = exes || [];
                    fetchExercises(index + 1);
                });
            };
            fetchExercises(0);
        });
    });
});

app.post('/api/user/program/start', (req, res) => {
    const { tg_id, program_id } = req.body;
    if (!tg_id || !program_id) return res.status(400).json({ error: 'Missing fields' });
    
    db.run("UPDATE user_programs SET active = 0 WHERE tg_id = ?", [tg_id], () => {
        db.run(`INSERT INTO user_programs (tg_id, program_id, start_date, current_week, current_day, active) 
            VALUES (?, ?, date('now'), 1, 1, 1)`,
            [tg_id, program_id],
            (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ status: 'ok' });
            }
        );
    });
});

app.get('/api/user/program/:tgId', (req, res) => {
    db.get(`SELECT up.*, p.name as program_name, p.location, p.type, p.duration_weeks, p.description, p.difficulty
        FROM user_programs up 
        JOIN programs p ON up.program_id = p.id 
        WHERE up.tg_id = ? AND up.active = 1`, [req.params.tgId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ program: row || null });
    });
});

app.post('/api/user/program/progress', (req, res) => {
    const { tg_id, week, day } = req.body;
    if (!tg_id) return res.status(400).json({ error: 'Missing tg_id' });
    db.run("UPDATE user_programs SET current_week = ?, current_day = ? WHERE tg_id = ? AND active = 1",
        [week, day, tg_id],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ status: 'ok' });
        }
    );
});

app.post('/api/user/program/complete', (req, res) => {
    const { tg_id } = req.body;
    if (!tg_id) return res.status(400).json({ error: 'Missing tg_id' });
    db.run("UPDATE user_programs SET active = 0, completed = 1 WHERE tg_id = ? AND active = 1",
        [tg_id],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ status: 'ok' });
        }
    );
});

app.post('/api/workout/log', (req, res) => {
    const { tg_id, program_id, program_day_id, duration_minutes, total_volume, notes, sets } = req.body;
    if (!tg_id) return res.status(400).json({ error: 'Missing tg_id' });
    
    const today = new Date().toISOString().split('T')[0];
    db.run(`INSERT INTO workout_logs (tg_id, program_id, program_day_id, date, duration_minutes, total_volume, notes) 
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [tg_id, program_id || null, program_day_id || null, today, duration_minutes || 0, total_volume || 0, notes || ''],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const logId = this.lastID;
            
            if (sets && sets.length > 0) {
                const stmt = db.prepare(`INSERT INTO workout_sets 
                    (log_id, exercise_id, set_number, reps, weight) 
                    VALUES (?, ?, ?, ?, ?)`);
                sets.forEach(s => {
                    stmt.run(logId, s.exercise_id, s.set_number, s.reps, s.weight || 0);
                });
                stmt.finalize();
            }
            res.json({ status: 'ok', log_id: logId });
        }
    );
});

app.get('/api/workout/logs/:tgId', (req, res) => {
    db.all(`SELECT wl.*, p.name as program_name 
        FROM workout_logs wl 
        LEFT JOIN programs p ON wl.program_id = p.id 
        WHERE wl.tg_id = ? 
        ORDER BY wl.date DESC LIMIT 50`, [req.params.tgId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ logs: rows });
    });
});

app.get('/api/workout/log/:id', (req, res) => {
    db.get("SELECT * FROM workout_logs WHERE id = ?", [req.params.id], (err, log) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!log) return res.status(404).json({ error: 'Not found' });
        
        db.all(`SELECT ws.*, e.name as exercise_name 
            FROM workout_sets ws 
            JOIN exercises e ON ws.exercise_id = e.id 
            WHERE ws.log_id = ?`, [req.params.id], (err, sets) => {
            res.json({ log, sets: sets || [] });
        });
    });
});

app.post('/api/water', (req, res) => {
    const { tg_id, amount } = req.body;
    if (!tg_id || !amount) return res.status(400).json({ error: 'Missing fields' });
    const today = new Date().toISOString().split('T')[0];
    
    db.get("SELECT amount_ml FROM water_logs WHERE tg_id = ? AND date = ?", [tg_id, today], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) {
            db.run("UPDATE water_logs SET amount_ml = amount_ml + ? WHERE tg_id = ? AND date = ?",
                [amount, tg_id, today],
                (err) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ status: 'ok', total: row.amount_ml + amount });
                }
            );
        } else {
            db.run("INSERT INTO water_logs (tg_id, date, amount_ml) VALUES (?, ?, ?)",
                [tg_id, today, amount],
                (err) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ status: 'ok', total: amount });
                }
            );
        }
    });
});

app.get('/api/water/:tgId', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    db.get("SELECT amount_ml FROM water_logs WHERE tg_id = ? AND date = ?", [req.params.tgId, today], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ amount: row ? row.amount_ml : 0 });
    });
});

app.post('/api/weight', (req, res) => {
    const { tg_id, weight } = req.body;
    if (!tg_id || !weight) return res.status(400).json({ error: 'Missing fields' });
    const today = new Date().toISOString().split('T')[0];
    db.run("INSERT OR REPLACE INTO weight_logs (tg_id, date, weight) VALUES (?, ?, ?)",
        [tg_id, today, weight],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ status: 'ok' });
        }
    );
});

app.get('/api/weight/:tgId', (req, res) => {
    db.all("SELECT date, weight FROM weight_logs WHERE tg_id = ? ORDER BY date DESC LIMIT 30", [req.params.tgId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ history: rows || [] });
    });
});

app.get('/api/achievements/:tgId', (req, res) => {
    db.all("SELECT * FROM achievements", [], (err, allAch) => {
        if (err) return res.status(500).json({ error: err.message });
        db.all("SELECT achievement_id FROM user_achievements WHERE tg_id = ?", [req.params.tgId], (err, userAch) => {
            if (err) return res.status(500).json({ error: err.message });
            const unlocked = new Set((userAch || []).map(a => a.achievement_id));
            res.json({ 
                achievements: allAch.map(a => ({...a, unlocked: unlocked.has(a.id)})) 
            });
        });
    });
});

app.listen(process.env.MINIAPP_PORT || 3000, () => {
    console.log(`GuideFit server started on port ${process.env.MINIAPP_PORT || 3000}`);
});
