const express = require('express');
require('dotenv').config();
const crypto = require('crypto');
const db = require('./db');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('static'));

app.use('/api/', (req, res, next) => { res.type('json'); next(); });

/* ================= helpers: локальная дата ================= */
function pad(n) { return String(n).padStart(2, '0'); }
function localDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function dayDiff(a, b) {
  return Math.round((Date.parse(a + 'T00:00:00') - Date.parse(b + 'T00:00:00')) / 86400000);
}

/* ================= Telegram initData: валидация ================= */
function validateInitData(initData) {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) return { valid: false, reason: 'no-token' };
  if (!initData || typeof initData !== 'string') return { valid: false };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { valid: false };
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => k + '=' + v).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const calcHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const _a = Buffer.from(calcHash, 'hex'), _b = Buffer.from(hash, 'hex');
  if (_a.length !== _b.length || !crypto.timingSafeEqual(_a, _b)) return { valid: false };
  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user && user.id ? { valid: true, id: String(user.id) } : { valid: false };
  } catch (e) { return { valid: false }; }
}

app.use('/api', (req, res, next) => {
  const check = validateInitData(req.headers['x-telegram-init-data']);
  if (check.valid) req.tgUserId = check.id;
  next();
});

// Какому tg_id разрешено работать с запросом
function resolveTgId(req) {
  const requested = String(req.body?.tg_id ?? req.query?.tg_id ?? req.params?.tgId ?? '');
  if (req.tgUserId) return req.tgUserId;          // подписанные данные Telegram имеют приоритет
  if (!process.env.TELEGRAM_TOKEN) return requested; // dev-режим без токена
  // v14: demo_user закрыт (аудит) — без TELEGRAM_TOKEN всё равно пускает любого
  return null;                                     // иначе — попытка подмены, отказ
}

/* ================= расчёты ================= */
const ACTIVITY_MULTIPLIERS = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };

function calcCalories(current_weight, height, age, gender, activity_level, goal) {
  const w = Number(current_weight), h = Number(height), a = Number(age);
  if (!w || !h || !a) return null; // нет данных — не считаем мусор
  let bmr = 10 * w + 6.25 * h - 5 * a;
  bmr += gender === 'male' ? 5 : -161;
  const mult = ACTIVITY_MULTIPLIERS[activity_level] || 1.375;
  let norm = Math.round(bmr * mult);
  if (goal === 'lose') norm -= 500;
  if (goal === 'gain') norm += 500;
  return norm;
}

// Честные нормы от веса: белки 1.8–2 г/кг, жиры 1 г/кг, углеводы — остаток калорий, вода 30 мл/кг
function calcNorms(user) {
  const w = Number(user.current_weight) || 70;
  const protein = Math.round(w * (user.goal === 'gain' ? 2 : 1.8));
  const fat = Math.round(w * 1);
  const kcal = Number(user.calorie_norm) || 2000;
  const carbs = Math.max(Math.round((kcal - protein * 4 - fat * 9) / 4), 0);
  const water = Math.round(w * 30);
  return { calories: kcal, protein, fat, carbs, water };
}

function calcStreak(tg_id, callback) {
  db.all("SELECT date FROM workout_logs WHERE tg_id = ? ORDER BY date DESC", [tg_id], (err, rows) => {
    if (err || !rows.length) return callback(0);
    const dates = [...new Set(rows.map(r => r.date))].sort().reverse();
    if (dates[0] !== localDate() && dates[0] !== localDate(-1)) return callback(0);
    let streak = 1;
    for (let i = 1; i < dates.length; i++) {
      if (dayDiff(dates[i - 1], dates[i]) === 1) streak++;
      else break;
    }
    callback(streak);
  });
}

/* ================= уведомления в Telegram ================= */
async function sendTelegram(tg_id, text) {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token || !tg_id || tg_id === 'demo_user') return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tg_id, text }),
      signal: AbortSignal.timeout(5000)
    }).catch(e => console.error('TG send:', e.message));
  } catch (e) { console.error('TG send error:', e.message); }
}

// Уведомление с дедупликацией: один тип — один раз в день на пользователя
function notifyOnce(tg_id, type, dateStr, text) {
  db.run("INSERT OR IGNORE INTO notification_log (tg_id, type, date) VALUES (?, ?, ?)",
    [tg_id, type, dateStr], function (err) {
      if (!err && this.changes > 0) sendTelegram(tg_id, text);
    });
}

/* ================= достижения ================= */
function checkAchievements(tg_id) {
  if (!tg_id || tg_id === 'demo_user') return;
  db.get("SELECT current_weight FROM users WHERE tg_id = ?", [tg_id], (err, u) => {
    const waterNorm = Math.round((Number(u?.current_weight) || 70) * 30);
    db.all("SELECT achievement_id FROM user_achievements WHERE tg_id = ?", [tg_id], (err, ua) => {
      const unlocked = new Set((ua || []).map(a => a.achievement_id));
      db.all("SELECT * FROM achievements", [], (err, all) => {
        if (err) return;
        db.get("SELECT COUNT(*) c, COALESCE(SUM(total_volume),0) v FROM workout_logs WHERE tg_id = ?", [tg_id], (err, w) => {
          db.get("SELECT COUNT(*) c FROM food_logs WHERE tg_id = ?", [tg_id], (err, m) => {
            calcStreak(tg_id, (streak) => {
              // серия дней с выполненной нормой воды
              let waterStreak = 0;
              db.all("SELECT date, amount_ml FROM water_logs WHERE tg_id = ? ORDER BY date DESC LIMIT 30", [tg_id], (err, wr) => {
                const wmap = {};
                (wr || []).forEach(r => wmap[r.date] = r.amount_ml);
                for (let i = 0; ; i++) {
                  const d = localDate(-i);
                  if (wmap[d] === undefined) { if (i === 0) continue; else break; }
                  if (wmap[d] >= waterNorm) waterStreak++;
                  else break;
                }
                const stats = {
                  workouts: w?.c || 0,
                  volume: w?.v || 0,
                  meals: m?.c || 0,
                  workout_streak: streak,
                  water_streak: waterStreak
                };
                all.forEach(a => {
                  if (unlocked.has(a.id)) return;
                  const val = stats[a.condition_type] || 0;
                  if (val >= a.condition_value) {
                    db.run("INSERT OR IGNORE INTO user_achievements (tg_id, achievement_id) VALUES (?, ?)",
                      [tg_id, a.id], function (err2) {
                        if (!err2 && this.changes > 0) {
                          sendTelegram(tg_id, `🏅 Новое достижение: ${a.icon} «${a.title}»\n${a.description}`);
                        }
                      });
                  }
                });
              });
            });
          });
        });
      });
    });
  });
}

/* ================= пользователь ================= */
// --- v14: безопасность без новых зависимостей ---
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
const rlHits = new Map();
app.use('/api', (req, res, next) => {
  const key = req.ip + ':' + req.path;
  const now = Date.now();
  const h = rlHits.get(key) || { n: 0, t: now };
  if (now - h.t > 60000) { h.n = 0; h.t = now; }
  h.n++;
  if (rlHits.size > 20000) rlHits.clear();
  rlHits.set(key, h);
  if (h.n > 120) return res.status(429).json({ error: 'Too many requests' });
  next();
});
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/user/init', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  const { name, goal, gender, age, height, current_weight, target_weight, activity_level } = req.body;
  if (!name || !goal || !gender || !age || !height || !current_weight) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  if (!(age >= 10 && age <= 100) || !(height >= 120 && height <= 230) ||
      !(current_weight >= 20 && current_weight <= 400) ||
      (target_weight && !(target_weight >= 20 && target_weight <= 400))) {
    return res.status(400).json({ error: 'Invalid values' });
  }
  const al = activity_level || 'moderate';
  const calorie_norm = calcCalories(current_weight, height, age, gender, al, goal);
  db.run(
    `INSERT INTO users (tg_id, name, goal, gender, age, height, current_weight, target_weight, calorie_norm, activity_level)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tg_id) DO UPDATE SET
       name=excluded.name, goal=excluded.goal, gender=excluded.gender, age=excluded.age,
       height=excluded.height, current_weight=excluded.current_weight,
       target_weight=excluded.target_weight, calorie_norm=excluded.calorie_norm,
       activity_level=excluded.activity_level`,
    [tgId, name, goal, gender, age, height, current_weight, target_weight || current_weight, calorie_norm, al],
    (err) => {
      if (err) { console.error(err); return res.status(500).json({ error: 'Database error' }); }
      res.json({ status: 'ok', calorie_norm });
    }
  );
});

app.get('/api/user/:tgId', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  db.get("SELECT * FROM users WHERE tg_id = ?", [tgId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'User not found' });
    res.json(row);
  });
});

app.post('/api/user/update', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  db.get("SELECT * FROM users WHERE tg_id = ?", [tgId], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    const fields = {};
    ['current_weight', 'target_weight', 'goal', 'activity_level', 'name', 'age', 'height'].forEach(k => {
      if (req.body[k] !== undefined) fields[k] = req.body[k];
    });
    if (req.body.meal_count !== undefined) {
      const mc = parseInt(req.body.meal_count);
      if (mc >= 2 && mc <= 6) fields.meal_count = mc;
    }
    const merged = { ...user, ...fields };
    const calorie_norm = calcCalories(
      merged.current_weight, merged.height, merged.age, merged.gender,
      merged.activity_level, merged.goal
    ) ?? user.calorie_norm; // если данных не хватило — сохраняем старую норму, не NaN
    fields.calorie_norm = calorie_norm;
    const keys = Object.keys(fields);
    const sql = "UPDATE users SET " + keys.map(k => k + " = ?").join(", ") + " WHERE tg_id = ?";
    db.run(sql, [...keys.map(k => fields[k]), tgId], (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ status: 'ok', calorie_norm, meal_count: merged.meal_count });
    });
  });
});

/* ================= Pexels фото ================= */
async function fetchPexelsPhoto(query) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=square`, {
      headers: { 'Authorization': key }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.photos && data.photos.length > 0) {
      return data.photos[0].src.medium || data.photos[0].src.small;
    }
    return null;
  } catch (e) {
    console.error('Pexels error:', e.message);
    return null;
  }
}

app.get('/api/recipe-image/:id', async (req, res) => {
  db.get("SELECT title, image_url, photo_query FROM recipes WHERE id = ?", [req.params.id], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Not found' });
    const hasReal = row.image_url && row.image_url.length > 3 && row.image_url !== 'empty.jpg';
    if (hasReal) return res.json({ image_url: row.image_url, cached: true });
    const url = await fetchPexelsPhoto(row.photo_query || (row.title + ' food dish'));
    if (url) {
      db.run("UPDATE recipes SET image_url = ? WHERE id = ?", [url, req.params.id],
        (err2) => { if (err2) console.error('cache err:', err2.message); });
      return res.json({ image_url: url, cached: false });
    }
    res.json({ image_url: '', cached: false });
  });
});

/* ================= статистика и дашборд ================= */
app.get('/api/stats/:tgId', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  const today = localDate();
  const dayOfWeek = new Date().getDay() || 7;
  const days = [];
  for (let i = 0; i < 7; i++) days.push(localDate(i - dayOfWeek + 1));
  db.get("SELECT calorie_norm, current_weight FROM users WHERE tg_id = ?", [tgId], (err, user) => {
    const target = user?.calorie_norm || 2000;
    const currentWeight = user?.current_weight || null;
    const placeholders = days.map(() => '?').join(',');
    db.all(`SELECT date(fl.timestamp) as dt, SUM(r.calories) as cals
        FROM food_logs fl JOIN recipes r ON fl.recipe_id = r.id
        WHERE fl.tg_id = ? AND date(fl.timestamp) IN (${placeholders})
        GROUP BY date(fl.timestamp)`, [tgId, ...days], (err, calRows) => {
      const calMap = {};
      (calRows || []).forEach(r => calMap[r.dt] = r.cals);
      db.all(`SELECT date, duration_minutes FROM workout_logs WHERE tg_id = ? AND date IN (${placeholders})`,
        [tgId, ...days], (err, workoutRows) => {
          const workoutMap = {};
          (workoutRows || []).forEach(r => workoutMap[r.date] = (workoutMap[r.date] || 0) + r.duration_minutes);
          db.get("SELECT amount_ml FROM water_logs WHERE tg_id = ? AND date = ?", [tgId, today], (err, waterRow) => {
            db.get("SELECT weight FROM weight_logs WHERE tg_id = ? ORDER BY date DESC LIMIT 1", [tgId], (err, weightRow) => {
              const weekData = days.map((d, idx) => ({
                date: d,
                dayShort: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'][idx],
                calories: calMap[d] || 0,
                percent: target > 0 ? Math.round(((calMap[d] || 0) / target) * 100) : 0,
                isToday: d === today,
                hasWorkout: !!workoutMap[d]
              }));
              const todayData = weekData.find(d => d.isToday) || weekData[6];
              res.json({
                todayCalories: todayData.calories,
                targetCalories: target,
                week: weekData,
                hasWorkoutToday: !!workoutMap[today],
                workoutMinutes: workoutMap[today] || 0,
                currentWeight: weightRow ? weightRow.weight : currentWeight,
                waterToday: waterRow ? waterRow.amount_ml : 0
              });
            });
          });
        });
    });
  });
});

app.post('/api/dashboard', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  db.get("SELECT * FROM users WHERE tg_id = ?", [tgId], (err, user) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const today = localDate();
    db.all(`SELECT r.* FROM food_logs fl JOIN recipes r ON fl.recipe_id = r.id
        WHERE fl.tg_id = ? AND date(fl.timestamp) = ?`, [tgId, today], (err, meals) => {
      const consumption = { calories: 0, protein: 0, fat: 0, carbs: 0 };
      (meals || []).forEach(m => {
        consumption.calories += m.calories || 0;
        consumption.protein += m.protein || 0;
        consumption.fat += m.fat || 0;
        consumption.carbs += m.carbs || 0;
      });
      db.get("SELECT amount_ml FROM water_logs WHERE tg_id = ? AND date = ?", [tgId, today], (err, water) => {
        db.get("SELECT COUNT(*) as count FROM workout_logs WHERE tg_id = ? AND date = ?", [tgId, today], (err, workout) => {
          db.get(`SELECT up.*, p.name as program_name, p.location, p.type, p.duration_weeks, p.description, p.difficulty
              FROM user_programs up JOIN programs p ON up.program_id = p.id
              WHERE up.tg_id = ? AND up.active = 1`, [tgId], (err, program) => {
            const finish = (programWithDays) => {
              const hour = new Date().getHours();
              let nextMeal = 'breakfast';
              if (hour >= 10) nextMeal = 'lunch';
              if (hour >= 15) nextMeal = 'snack';
              if (hour >= 18) nextMeal = 'dinner';
              calcStreak(tgId, (streak) => {
                res.json({
                  streak,
                  consumption,
                  norms: calcNorms(user),
                  user,
                  nextMeal,
                  mealsToday: (meals || []).length,
                  water: water ? water.amount_ml : 0,
                  hasWorkout: !!(workout && workout.count > 0),
                  activeProgram: programWithDays,
                  todayMeals: (meals || []).map(m => ({
                    id: m.id, title: m.title, category: m.category,
                    calories: m.calories, image_url: (m.image_url && m.image_url !== 'empty.jpg') ? m.image_url : ''
                  }))
                });
              });
            };
            if (program) {
              db.get("SELECT COUNT(*) c FROM program_days WHERE program_id = ?", [program.program_id], (err, c) => {
                program.total_days = c?.c || 0;
                finish(program);
              });
            } else finish(null);
          });
        });
      });
    });
  });
});

/* ================= рецепты и дневник питания ================= */
app.post('/api/meal', (req, res) => {
  const { category, goal, exclude_id } = req.body;
  if (!category) return res.status(400).json({ error: 'Missing category' });
  let sql = "SELECT * FROM recipes WHERE category = ?";
  const params = [category];
  if (goal) { sql += " AND (goals LIKE ? OR goals IS NULL OR goals = '')"; params.push('%' + goal + '%'); }
  if (exclude_id) { sql += " AND id != ?"; params.push(exclude_id); }
  const maxK = parseFloat(req.body.max_calories);
  let baseSql = sql;
  const baseParams = params.slice();
  if (exclude_id) { baseSql += " AND id != ?"; baseParams.push(exclude_id); }
  const pick = (withCap, withExclude) => {
    let sql2 = withExclude ? baseSql : sql;
    const p2 = (withExclude ? baseParams : params).slice();
    if (withCap && maxK > 0) { sql2 += " AND calories <= ?"; p2.push(Math.round(maxK * 1.15)); }
    sql2 += " ORDER BY RANDOM() LIMIT 1";
    db.get(sql2, p2, (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row && withCap && maxK > 0) return pick(false, withExclude);
      if (!row && withExclude) return pick(withCap, false); // v16: «Другое» не падает в 404
      if (!row) return res.status(404).json({ error: 'Recipe not found' });
    if (row.ingredients) try { row.ingredients = JSON.parse(row.ingredients); } catch (e) {}
    if (row.recipe_steps) try { row.recipe_steps = JSON.parse(row.recipe_steps); } catch (e) {}
    res.json({ recipe: row });
    });
  };
  pick(true, true);
});

app.get('/api/recipe/:id', (req, res) => {
  db.get("SELECT * FROM recipes WHERE id = ?", [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.ingredients) try { row.ingredients = JSON.parse(row.ingredients); } catch (e) {}
    if (row.recipe_steps) try { row.recipe_steps = JSON.parse(row.recipe_steps); } catch (e) {}
    res.json(row);
  });
});

app.post('/api/log-meal', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  const { recipe_id } = req.body;
  if (!recipe_id) return res.status(400).json({ error: 'Missing fields' });
  db.run("INSERT INTO food_logs (tg_id, recipe_id, timestamp) VALUES (?, ?, datetime('now','localtime'))",
    [tgId, recipe_id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      checkAchievements(tgId);
      res.json({ status: 'ok' });
    });
});

app.delete('/api/food-log/:id', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  db.run("DELETE FROM food_logs WHERE id = ? AND tg_id = ?", [req.params.id, tgId], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ status: 'ok', deleted: this.changes });
  });
});

app.get('/api/food-log/today/:tgId', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  db.all(`SELECT fl.id as log_id, r.*, fl.timestamp
      FROM food_logs fl JOIN recipes r ON fl.recipe_id = r.id
      WHERE fl.tg_id = ? AND date(fl.timestamp) = ?
      ORDER BY fl.timestamp DESC`, [tgId, localDate()], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ meals: rows || [] });
  });
});

app.get('/api/shopping-list/:tgId', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  db.all(`SELECT r.ingredients FROM food_logs f JOIN recipes r ON f.recipe_id = r.id
      WHERE f.tg_id = ? AND f.date >= date('now', '-7 days')`,
    [tgId], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const SMALL = /(ст\.?\s*л|столов|ч\.?\s*л|чайн|щепот|по вкусу|зубч|пуч|доль|ломт|лист|веточ|горсть)/i;
      const reAmt = /^(.*?)[\s\u2014\u2013-]+(\d+(?:[.,]\d+)?)\s*(г|гр|грамм(?:а|ов)?|мл|кг|л|шт|штук(?:и|а)?|стакан(?:а)?|чашк(?:а|и)|банк(?:а|и)|упаковк(?:а|и)|пакет(?:а)?|кус(?:ок|ка)|порци(?:я|и))\.?$/i;
      const agg = new Map();
      rows.forEach(r => {
        let ings = r.ingredients;
        if (!ings) return;
        try { ings = JSON.parse(ings); } catch (e) {}
        [].concat(ings).forEach(raw => {
          const str = String(raw).trim();
          if (!str) return;
          const mm = str.match(reAmt);
          if (mm && !SMALL.test(mm[3])) {
            const name = mm[1].trim();
            const qty = parseFloat(mm[2].replace(',', '.'));
            if (!name || !isFinite(qty)) return;
            let unit = mm[3].toLowerCase().replace(/\.$/, '');
            if (/^(гр|грамм.*)$/.test(unit)) unit = 'г';
            if (/^штук/.test(unit)) unit = 'шт';
            const key = name + '|' + unit;
            const cur = agg.get(key) || { name, qty: 0, unit };
            cur.qty += qty;
            agg.set(key, cur);
          } else {
            const name = (mm ? mm[1] : str.replace(/\s+\d+(?:[.,]\d+)?[\s\S]*$/, '')).trim();
            if (name) agg.set('n:' + name, { name, qty: 0, unit: null });
          }
        });
      });
      const items = Array.from(agg.values())
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
        .map(v => v.unit ? (v.name + ' — ' + (v.qty >= 10 ? Math.round(v.qty) : Math.round(v.qty * 10) / 10) + ' ' + v.unit) : v.name);
      res.json({ items });
    });
});

app.get('/api/weekly-report/:tgId', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  db.all("SELECT date, duration_minutes, total_volume FROM workout_logs WHERE tg_id = ? AND date >= ? ORDER BY date",
    [tgId, localDate(-7)], (err, workouts) => {
      db.all("SELECT date, weight FROM weight_logs WHERE tg_id = ? AND date >= ? ORDER BY date",
        [tgId, localDate(-7)], (err, weights) => {
          db.all(`SELECT r.calories FROM food_logs fl JOIN recipes r ON fl.recipe_id = r.id
              WHERE fl.tg_id = ? AND date(fl.timestamp) >= ?`, [tgId, localDate(-7)], (err, meals) => {
            const totalMinutes = (workouts || []).reduce((s, w) => s + (w.duration_minutes || 0), 0);
            const totalVolume = (workouts || []).reduce((s, w) => s + (w.total_volume || 0), 0);
            const avgCals = meals?.length ? Math.round(meals.reduce((s, m) => s + (m.calories || 0), 0) / 7) : 0;
            const weightChange = weights?.length >= 2 ? (weights[weights.length - 1].weight - weights[0].weight).toFixed(1) : 0;
            res.json({
              totalWorkouts: (workouts || []).length,
              totalMinutes,
              totalVolume,
              avgCalories: avgCals,
              weightChange,
              weightFirst: weights?.length ? weights[0].weight : null,
              weightLast: weights?.length ? weights[weights.length - 1].weight : null
            });
          });
        });
    });
});

/* ================= упражнения и программы ================= */
app.get('/api/exercises', (req, res) => {
  const { location, type, muscle } = req.query;
  let sql = "SELECT * FROM exercises WHERE 1=1";
  const params = [];
  if (location) { sql += " AND location = ?"; params.push(location); }
  if (type) { sql += " AND type = ?"; params.push(type); }
  if (muscle) { sql += " AND muscle_group = ?"; params.push(muscle); }
  sql += " ORDER BY name";
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    rows.forEach(r => { r.tips = Array.isArray(r.tips) ? r.tips : (r.tips ? [r.tips] : []); });
    res.json({ exercises: rows });
  });
});

app.get('/api/exercise/:id', (req, res) => {
  db.get("SELECT * FROM exercises WHERE id = ?", [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Not found' });
    row.tips = Array.isArray(row.tips) ? row.tips : (row.tips ? [row.tips] : []);
    res.json(row);
  });
});

app.get('/api/programs', (req, res) => {
  const { location, type, goal } = req.query;
  let sql = "SELECT * FROM programs WHERE 1=1";
  const params = [];
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
      const fetchExercises = (index) => {
        if (index >= days.length) return res.json({ program, days, totalDays: days.length });
        db.all(`SELECT pe.*, e.name as exercise_name, e.muscle_group, e.description as exercise_desc
            FROM program_exercises pe JOIN exercises e ON pe.exercise_id = e.id
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
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  const { program_id } = req.body;
  if (!program_id) return res.status(400).json({ error: 'Missing fields' });
  db.run("UPDATE user_programs SET active = 0 WHERE tg_id = ?", [tgId], () => {
    db.run(`INSERT INTO user_programs (tg_id, program_id, start_date, current_week, current_day, active)
        VALUES (?, ?, ?, 1, 1, 1)`, [tgId, program_id, localDate()], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ status: 'ok' });
    });
  });
});

app.get('/api/user/program/:tgId', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  db.get(`SELECT up.*, p.name as program_name, p.location, p.type, p.duration_weeks, p.description, p.difficulty
      FROM user_programs up JOIN programs p ON up.program_id = p.id
      WHERE up.tg_id = ? AND up.active = 1`, [tgId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.json({ program: null });
    db.get("SELECT COUNT(*) c FROM program_days WHERE program_id = ?", [row.program_id], (err2, c) => {
      row.total_days = c?.c || 0;
      res.json({ program: row });
    });
  });
});

// Сервер сам продвигает программу на следующий день — фронту не нужно ничего считать
app.post('/api/user/program/progress', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  db.get("SELECT * FROM user_programs WHERE tg_id = ? AND active = 1", [tgId], (err, up) => {
    if (err || !up) return res.status(404).json({ error: 'No active program' });
    db.all("SELECT * FROM program_days WHERE program_id = ? ORDER BY week, day", [up.program_id], (err, days) => {
      const idx = days.findIndex(d => d.week === up.current_week && d.day === up.current_day);
      const next = days[idx + 1];
      if (!next) {
        db.run("UPDATE user_programs SET active = 0, completed = 1 WHERE id = ?", [up.id], (err2) => {
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({ status: 'ok', completed: true });
        });
      } else {
        db.run("UPDATE user_programs SET current_week = ?, current_day = ? WHERE id = ?",
          [next.week, next.day, up.id], (err2) => {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ status: 'ok', completed: false, week: next.week, day: next.day });
          });
      }
    });
  });
});

app.post('/api/user/program/complete', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  db.run("UPDATE user_programs SET active = 0, completed = 1 WHERE tg_id = ? AND active = 1", [tgId], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ status: 'ok' });
  });
});

/* ================= тренировки ================= */
app.post('/api/workout/log', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  // v14: total_volume от клиента игнорируем — считаем сами из подходов (аудит)
  const { program_id, program_day_id, duration_minutes, notes, sets } = req.body;
  let _cleanSets = [];
  if (Array.isArray(sets)) {
    if (sets.length > 60) return res.status(400).json({ error: 'Too many sets' });
    for (const s2 of sets) {
      const reps = Math.round(Number(s2.reps));
      const wgt = Number(s2.weight) || 0;
      if (!(reps >= 0 && reps <= 500) || !(wgt >= 0 && wgt <= 1000)) return res.status(400).json({ error: 'Invalid set' });
      _cleanSets.push({ exercise_id: s2.exercise_id || null, set_number: s2.set_number || 0, reps, weight: wgt });
    }
  }
  const _totalVolume = _cleanSets.reduce((sum, x) => sum + x.reps * x.weight, 0);
  db.run(`INSERT INTO workout_logs (tg_id, program_id, program_day_id, date, duration_minutes, total_volume, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [tgId, program_id || null, program_day_id || null, localDate(),
     Math.min(Number(duration_minutes) || 0, 600), _totalVolume, String(notes || '').slice(0, 300)],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      const logId = this.lastID;
      if (_cleanSets.length > 0) {
        const stmt = db.prepare(`INSERT INTO workout_sets (log_id, exercise_id, set_number, reps, weight)
            VALUES (?, ?, ?, ?, ?)`);
        _cleanSets.forEach(s3 => stmt.run(logId, s3.exercise_id, s3.set_number, s3.reps, s3.weight));
        stmt.finalize();
      }
      checkAchievements(tgId);
      res.json({ status: 'ok', log_id: logId, total_volume: _totalVolume });
    });
});

app.get('/api/workout/logs/:tgId', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  db.all(`SELECT wl.*, p.name as program_name
      FROM workout_logs wl LEFT JOIN programs p ON wl.program_id = p.id
      WHERE wl.tg_id = ? ORDER BY wl.date DESC LIMIT 50`, [tgId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ logs: rows || [] });
  });
});

app.get('/api/workout/log/:id', (req, res) => {
  const tgId = resolveTgId(req);
  db.get("SELECT * FROM workout_logs WHERE id = ? AND tg_id = ?", [req.params.id, tgId], (err, log) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!log) return res.status(404).json({ error: 'Not found' });
    db.all(`SELECT ws.*, e.name as exercise_name
        FROM workout_sets ws JOIN exercises e ON ws.exercise_id = e.id
        WHERE ws.log_id = ?`, [req.params.id], (err, sets) => {
      res.json({ log, sets: sets || [] });
    });
  });
});

/* ================= вода и вес ================= */
app.post('/api/water/undo', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  db.run("DELETE FROM water_logs WHERE id = (SELECT id FROM water_logs WHERE tg_id = ? AND date = ? ORDER BY id DESC LIMIT 1)",
    [tgId, localDate()], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ status: 'ok', removed: this.changes });
    });
});

app.post('/api/notifications/toggle', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  db.run("UPDATE users SET notify_enabled = CASE WHEN notify_enabled THEN 0 ELSE 1 END WHERE tg_id = ?", [tgId], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    db.get("SELECT notify_enabled FROM users WHERE tg_id = ?", [tgId], (e2, row) => {
      res.json({ status: 'ok', notify_enabled: row ? row.notify_enabled : 1 });
    });
  });
});

app.post('/api/water', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  const { amount } = req.body;
  if (!amount || !(amount > 0) || amount > 5000) return res.status(400).json({ error: 'Invalid amount' });
  const today = localDate();
  const respondWithTotal = () => {
    db.get("SELECT amount_ml FROM water_logs WHERE tg_id = ? AND date = ?", [tgId, today], (e, r) => {
      checkAchievements(tgId);
      res.json({ status: 'ok', total: r ? r.amount_ml : amount });
    });
  };
  db.run("UPDATE water_logs SET amount_ml = amount_ml + ? WHERE tg_id = ? AND date = ?",
    [amount, tgId, today], function (err2) {
      if (err2) return res.status(500).json({ error: err2.message });
      if (this.changes > 0) return respondWithTotal();
      db.run("INSERT OR IGNORE INTO water_logs (tg_id, date, amount_ml) VALUES (?, ?, ?)", [tgId, today, amount], (err3) => {
        if (err3) return res.status(500).json({ error: err3.message });
        respondWithTotal();
      });
    });
});

app.get('/api/water/:tgId', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  db.get("SELECT amount_ml FROM water_logs WHERE tg_id = ? AND date = ?", [tgId, localDate()], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ amount: row ? row.amount_ml : 0 });
  });
});

app.post('/api/weight', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  const { weight } = req.body;
  if (!weight || !(weight >= 20) || weight > 400) return res.status(400).json({ error: 'Invalid weight' });
  db.run("INSERT OR REPLACE INTO weight_logs (tg_id, date, weight) VALUES (?, ?, ?)",
    [tgId, localDate(), weight], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      db.get("SELECT gender, height, age, activity_level, goal FROM users WHERE tg_id = ?", [tgId], (e2, u) => {
        const norm = (e2 || !u) ? null : calcCalories(weight, u.height, u.age, u.gender, u.activity_level, u.goal);
        if (norm) {
          db.run("UPDATE users SET current_weight = ?, calorie_norm = ? WHERE tg_id = ?", [weight, norm, tgId]);
          res.json({ status: 'ok', calorie_norm: norm });
        } else {
          db.run("UPDATE users SET current_weight = ? WHERE tg_id = ?", [weight, tgId]);
          res.json({ status: 'ok' });
        }
      });
    });
});

app.get('/api/weight/:tgId', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  db.all("SELECT date, weight FROM weight_logs WHERE tg_id = ? ORDER BY date DESC LIMIT 30", [tgId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ history: rows || [] });
  });
});

/* ================= достижения ================= */
app.get('/api/achievements/:tgId', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  checkAchievements(tgId); // ленивая разблокировка на случай пропущенных событий
  db.all("SELECT * FROM achievements", [], (err, allAch) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all("SELECT achievement_id FROM user_achievements WHERE tg_id = ?", [tgId], (err, userAch) => {
      if (err) return res.status(500).json({ error: err.message });
      const unlocked = new Set((userAch || []).map(a => a.achievement_id));
      res.json({ achievements: allAch.map(a => ({ ...a, unlocked: unlocked.has(a.id) })) });
    });
  });
});

/* ================= напоминания (раз в 30 мин) ================= */
function runReminders() {
  if (!process.env.TELEGRAM_TOKEN) return;
  const today = localDate();
  const hour = new Date().getHours();
  db.all("SELECT tg_id, name, created_at FROM users WHERE notify_enabled = 1", [], (err, users) => {
    if (err) return;
    (users || []).forEach(u => {
      if (u.tg_id === 'demo_user') return;
      // вес: не записывал 3+ дня
      if (hour === 10) {
        db.get("SELECT MAX(date) d FROM weight_logs WHERE tg_id = ?", [u.tg_id], (e, r) => {
          const last = r?.d || (u.created_at || '').slice(0, 10);
          if (last && dayDiff(today, last) >= 3) {
            notifyOnce(u.tg_id, 'weight:' + today, today, `⚖️ ${u.name}, время взвеситься! Открой GuideFit и обнови вес — так статистика будет точной.`);
          }
        });
      }
      // без тренировок 3 дня
      if (hour === 19) {
        db.get("SELECT MAX(date) d, COUNT(*) c FROM workout_logs WHERE tg_id = ?", [u.tg_id], (e, r) => {
          if (r && r.c > 0 && r.d && dayDiff(today, r.d) >= 3) {
            notifyOnce(u.tg_id, 'inactive:' + today, today, `🏃 ${u.name}, тебя не было 3 дня! Даже 15 минут тренировки вернут ритм. Заходи в GuideFit 💪`);
          }
        });
      }
      // приёмы пищи: в 9, 13, 17, 20 — если за последние 4 часа ничего не записано
      if ([9, 13, 17, 20].includes(hour)) {
        db.get(`SELECT COUNT(*) c FROM food_logs
            WHERE tg_id = ? AND date(timestamp) = ? AND CAST(strftime('%H', timestamp) AS INTEGER) BETWEEN ? AND ?`,
          [u.tg_id, today, Math.max(hour - 4, 0), hour], (e, r) => {
            if (r && r.c === 0) {
              notifyOnce(u.tg_id, 'meal' + hour + ':' + today, today, `🍽️ ${u.name}, приём пищи записан? Загляни в GuideFit — там идеи блюд под твою цель.`);
            }
          });
      }
    });
  });
}
function sendWeeklyReports() {
  const now = new Date();
  if (now.getDay() !== 1 || now.getHours() !== 9) return;
  const today = localDate();
  db.all("SELECT tg_id, name FROM users WHERE notify_enabled = 1", [], (e, users) => {
    if (e || !users) return;
    users.forEach(u => {
      db.get("SELECT COUNT(*) c FROM workout_logs WHERE tg_id = ? AND date >= date('now','-7 days')", [u.tg_id], (e1, w) => {
        db.get("SELECT COUNT(DISTINCT date) c FROM food_logs WHERE tg_id = ? AND date >= date('now','-7 days')", [u.tg_id], (e2, m) => {
          db.all("SELECT weight FROM weight_logs WHERE tg_id = ? ORDER BY date ASC, id ASC LIMIT 1", [u.tg_id], (e3, wr) => {
            db.all("SELECT weight FROM weight_logs WHERE tg_id = ? ORDER BY date DESC, id DESC LIMIT 1", [u.tg_id], (e4, wl) => {
              const wLine = (wr.length && wl.length) ? (' Вес: ' + wr[0].weight + ' → ' + wl[0].weight + ' кг.') : '';
              notifyOnce(u.tg_id, 'weekly:' + today, today, '📊 Неделя в GuideFit: тренировок — ' + (w ? w.c : 0) + ', дней с записанной едой — ' + (m ? m.c : 0) + ' из 7.' + wLine + ' Новая неделя — новый шаг к цели!');
            });
          });
        });
      });
    });
  });
}
setInterval(sendWeeklyReports, 30 * 60 * 1000);
setTimeout(sendWeeklyReports, 90 * 1000);

setInterval(runReminders, 30 * 60 * 1000);
setTimeout(runReminders, 15 * 1000);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal error' });
});

// --- Фото упражнений через Pexels (ключ в .env: PEXELS_API_KEY) ---
const photoCache = {};
app.get('/api/ex-photo', async (req, res) => {
  try{
    const q = String(req.query.q || '').slice(0, 80);
    if(!q) return res.json({ url: null });
    if(photoCache[q]) return res.json(photoCache[q]);
    const key = process.env.PEXELS_API_KEY;
    if(!key) return res.json({ url: null });
    const r = await fetch('https://api.pexels.com/v1/search?query=' + encodeURIComponent(q) + '&per_page=1&orientation=landscape', { headers: { Authorization: key } });
    const d = await r.json();
    const url = (d.photos && d.photos[0]) ? d.photos[0].src.medium : null;
    if(url) photoCache[q] = { url: url };
    res.json({ url: url });
  }catch(e){ res.json({ url: null }); }
});

// --- Йога ---
app.get('/api/yoga/flows', (req, res) => {
  db.all("SELECT id, title, focus, level, minutes, description FROM yoga_flows ORDER BY id", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ flows: rows });
  });
});
app.get('/api/yoga/flow/:id', (req, res) => {
  db.get("SELECT * FROM yoga_flows WHERE id = ?", [req.params.id], (err, flow) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!flow) return res.status(404).json({ error: 'not found' });
    db.all("SELECT p.name, p.how, p.why, fp.seconds FROM yoga_flow_poses fp JOIN yoga_poses p ON p.id = fp.pose_id WHERE fp.flow_id = ? ORDER BY fp.id", [req.params.id], (e2, poses) => {
      if (e2) return res.status(500).json({ error: e2.message });
      res.json({ flow: flow, poses: poses });
    });
  });
});

['SIGINT','SIGTERM'].forEach(sig => process.on(sig, () => {
  console.log('Остановка (' + sig + ')...');
  try { require('./db').close(); } catch(e){}
  process.exit(0);
}));

/* ================= 404 и ошибки ================= */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = Number(process.env.PORT || process.env.MINIAPP_PORT) || 3000;
const server = app.listen(PORT, () => {
  console.log(`GuideFit server started on port ${PORT}`);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Порт ${PORT} занят старым процессом. Останови его: pkill -f "node server.js" и запусти снова.`);
    process.exit(1);
  }
  throw e;
});
