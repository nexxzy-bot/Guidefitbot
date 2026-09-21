const express = require('express');
require('dotenv').config();
/* Часовой пояс СЕРВЕРА — только для служебных величин (сводка админки) и
   значений по умолчанию для аккаунтов без выбранного пояса.
   Всё пользовательское («сегодня», день недели, час подсказки) считается
   в поясе самого пользователя — см. блок helpers ниже. */
if (!process.env.TZ) process.env.TZ = 'Europe/Moscow';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
// Страховка: если db.js отдал пустой объект (битая/недописанная сборка или git-pull в момент старта),
// раньше это давало шквал «db.run is not a function» и 500 на каждый /api-запрос.
// Лучше громко упасть при старте — pm2 покажет причину.
if (!db || typeof db.run !== 'function' || typeof db.get !== 'function' || typeof db.all !== 'function') {
  console.error('Критично: db.js не вернул соединение с базой (проверь целостность db.js и наличие guidefit.db)');
  process.exit(1);
}

// Версия приложения — из package.json (показывается в «О приложении» и /api/health)
let APP_VERSION = '2.0.0';
try { APP_VERSION = require('./package.json').version || APP_VERSION; } catch (e) {}

// Telegram из приложения удалён: TELEGRAM_TOKEN/TELEGRAM_USERNAME/ADMIN_ID больше
// не участвуют в работе сервера. Они нужны только скрипту доставки сборок
// scripts/send-build.js (см. .env.example).

const app = express();
// Приложение стоит за nginx (app.xn--80aag3axnld9b.xn--p1ai → localhost:3000).
// Без trust proxy req.ip = 127.0.0.1 для ВСЕХ пользователей, и все лимиты
// (120 req/min, 10 анонимных аккаунтов в час) считались бы на один общий IP.
// 1 — доверяем ровно одному прокси впереди (nginx), реальный IP берём из X-Forwarded-For.
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.static('static'));

app.use('/api/', (req, res, next) => { res.type('json'); next(); });

/* ================= helpers: дата и часовой пояс =================
   Сама логика поясов живёт в time.js — чистыми функциями, чтобы её можно было
   покрыть тестами без запуска сервера (см. tests/tz.test.js).
   Здесь остаётся только то, что знает про запрос: чей это пояс и какой у
   пользователя день. */
const { APP_TZ, safeTz, tzOffsetMinutes, tzModifier, dateIn } = require('./time');

/** День пользователя из запроса (его пояс; без пояса — пояс сервера). */
function userDay(req, offsetDays) { return dateIn((req && req.tgTz) || APP_TZ, offsetDays); }
function userTzMod(req) { return tzModifier((req && req.tgTz) || APP_TZ); }

/** Текущий час в поясе пользователя — от него зависит подсказка «следующий приём»:
    для пользователя во Владивостоке серверный час врал на 7 часов.
    Пояс обязательно через safeTz(): имя пояса приходит от пользователя, и незнакомое
    («Foo/Bar» проходит проверку набора символов) роняло Intl с RangeError прямо
    внутри колбэка SQLite — то есть гасило весь сервер на одном запросе. */
function userHour(req) {
  return parseInt(new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', hour12: false, timeZone: safeTz((req && req.tgTz) || APP_TZ)
  }).format(new Date()), 10);
}

/** Ошибка «в коде», а не «в данных»: вызвали колбэк-хелпер без колбэка.
    Раньше это давало TypeError в колбэке SQLite и завершало процесс (exit 1) —
    теперь остаётся строкой в логе, а запрос доигрывает по фолбэку. */
function missingCallback(where) {
  console.error('Ошибка в коде: ' + where + ' вызван без колбэка — аргументы проверь!');
}

/* ================= страховка: ошибка в одном запросе не должна гасить сервер =================
   Express ловит исключения только из СИНХРОННОЙ части обработчика. Колбэки SQLite и
   промисы выполняются уже после его возврата, поэтому любое исключение внутри них
   (TypeError на неожиданных данных, RangeError на имени пояса, любая опечатка)
   поднималось до уровня процесса и Node завершался с кодом 1 — вместе с ним падал
   API для ВСЕХ пользователей сразу, пока pm2 не поднимет процесс заново.
   Такие ошибки относятся к одному запросу и состояние SQLite (WAL) на диске не портят,
   поэтому логируем, считаем и продолжаем обслуживание. Счётчик виден в /api/health —
   если он растёт, у сервера есть настоящая проблема, и молчать о ней нельзя.
   Ошибки старта это не прячет: сервер поднимается синхронно, до listen() ловить нечего. */
let uncaughtCount = 0;
function noteUncaught(kind, err) {
  uncaughtCount++;
  const msg = (err && err.message) || String(err);
  console.error(kind + ' #' + uncaughtCount + ': ' + msg);
  // стек печатаем только для первых двадцати — иначе одна сломанная ручка зальёт лог
  if (uncaughtCount <= 20 && err && err.stack) console.error(err.stack);
}
process.on('uncaughtException', (err) => noteUncaught('Необработанное исключение', err));
process.on('unhandledRejection', (err) => noteUncaught('Необработанный reject промиса', err));

function dayDiff(a, b) {
  return Math.round((Date.parse(a + 'T00:00:00') - Date.parse(b + 'T00:00:00')) / 86400000);
}

// Срок жизни сессии standalone/APK. Токен лежит в localStorage, бесконечный срок = бесконечная утечка.
const SESSION_TTL_SEC = 180 * 24 * 3600; // 180 дней
function sessionCutoff() { return Math.floor(Date.now() / 1000) - SESSION_TTL_SEC; }

app.use('/api', (req, res, next) => {
  // APK/standalone: единственный способ авторизации — сессия устройства
  // (анонимный аккаунт или вход через VK ID). Telegram initData больше не принимается.
  const sess = String(req.headers['x-session-token'] || '');
  if (!sess) return next();
  // Пояс пользователя тянем тем же запросом (JOIN, а не второй round-trip): от него
  // зависят все «дни» — дневник, вода, вес и серии.
  db.get(`SELECT s.tg_id, u.timezone FROM sessions s
          LEFT JOIN users u ON u.tg_id = s.tg_id
          WHERE s.token = ? AND s.created_at > ?`, [sess, sessionCutoff()], (err, row) => {
    if (!err && row && row.tg_id) { req.tgUserId = row.tg_id; req.tgTz = row.timezone || null; }
    next();
  });
});

// Какому tg_id разрешено работать с запросом.
// Идентификатор берём ТОЛЬКО из проверенной сессии: tg_id, присланный телом или
// параметром запроса, игнорируется — иначе любой мог бы читать и править чужой аккаунт.
function resolveTgId(req) {
  return req.tgUserId || null;
}

// Последний визит (для админки: "последний вход")
function touchSeen(tgId) {
  if (!tgId) return;
  db.run("UPDATE users SET last_seen = datetime('now') WHERE tg_id = ?", [tgId], () => {});
}

/* ================= журнал согласий (152-ФЗ, ст. 9/10) =================
   Согласие должно быть доказуемым: сохраняем факт, время и версии документов, с которыми
   пользователь согласился. Записи стираются вместе с аккаунтом (/api/user/delete). */
const CONSENT_DOC_VERSION = '2026-09-19'; // редакция privacy.html (19.09.2026) / terms.html (15.09.2026)
function logConsent(tgId, { privacy = 1, terms = 1, health = 1 } = {}) {
  if (!tgId) return;
  db.run("INSERT INTO consent_log (tg_id, privacy, terms, health, doc_version) VALUES (?, ?, ?, ?, ?)",
    [tgId, privacy ? 1 : 0, terms ? 1 : 0, health ? 1 : 0, CONSENT_DOC_VERSION], (err) => {
      if (err) console.error('consent log:', err.message);
    });
}

/* ================= расчёты ================= */
const ACTIVITY_MULTIPLIERS = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };

function calcCalories(current_weight, height, age, gender, activity_level, goal) {
  const w = Number(current_weight), h = Number(height), a = Number(age);
  if (!w || !h || !a || w <= 0 || h <= 0 || a <= 0) return null; // нет данных — не считаем мусор
  let bmr = 10 * w + 6.25 * h - 5 * a;
  bmr += gender === 'male' ? 5 : -161;
  const mult = ACTIVITY_MULTIPLIERS[activity_level] || 1.375;
  let norm = Math.round(bmr * mult);
  if (goal === 'lose') norm -= 500;
  if (goal === 'gain') norm += 500;
  return Math.max(norm, 1000); // пол: норма не бывает ниже физиологического минимума
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

function calcStreak(tg_id, tz, callback) {
  /* Устойчивость к прежнему вызову в два аргумента — calcStreak(tg_id, callback).
     Именно так он вызывался в /api/dashboard: поясом становился колбэк, а сам колбэк
     оставался undefined, и TypeError в колбэке SQLite убивал процесс целиком. */
  if (typeof tz === 'function' && callback === undefined) { callback = tz; tz = APP_TZ; }
  if (typeof callback !== 'function') return missingCallback('calcStreak');
  db.all("SELECT date FROM workout_logs WHERE tg_id = ? ORDER BY date DESC LIMIT 400", [tg_id], (err, rows) => {
    if (err || !rows || !rows.length) return callback(0);
    const dates = [...new Set(rows.map(r => r.date))].sort().reverse();
    if (dates[0] !== dateIn(tz) && dates[0] !== dateIn(tz, -1)) return callback(0);
    let streak = 1;
    for (let i = 1; i < dates.length; i++) {
      if (dayDiff(dates[i - 1], dates[i]) === 1) streak++;
      else break;
    }
    callback(streak);
  });
}

/* ================= уведомления админу ================= */
// Новая регистрация: строка в чат поддержки (видна в админ-панели).
// Telegram удалён, поэтому push админу больше не отправляется — уведомление живёт
// в админке. Ошибки не должны мешать регистрации — всё в try/catch.
function notifyAdminNewUser(tgId, name) {
  try {
    const text = '🆕 Новая регистрация в GuideFit: ' + (name || 'без имени') + ' (ID ' + tgId + ')';
    // sender NOT NULL: для ВК/анонимных (tg_id вида 'vk:…') отдавали null — вставка падала
    // с SQLITE_CONSTRAINT, и в админке не появлялось ни одной регистрации. Метка 'system'
    // отделяет служебную запись от переписки (в чате пользователя она скрыта).
    db.run("INSERT INTO support_messages (tg_id, sender, text) VALUES (?, ?, ?)",
      [tgId, 'system', text], function (e) {
        if (e) console.error('notifyAdminNewUser db:', e.message);
      });
  } catch (e) { console.error('notifyAdminNewUser:', e.message); }
}

/* ================= достижения ================= */
function bumpAchievements(tg_id) {
  try { checkAchievements(tg_id); } catch (e) { console.error('bumpAchievements:', e.message); }
}

function checkAchievements(tg_id) {
  if (!tg_id || tg_id === 'demo_user') return;
  // пояс тянем здесь же: серии считаются днями ПОЛЬЗОВАТЕЛЯ, не сервера
  db.get("SELECT current_weight, timezone FROM users WHERE tg_id = ?", [tg_id], (err, u) => {
    const tz = (u && u.timezone) || APP_TZ;
    const waterNorm = Math.round((Number(u?.current_weight) || 70) * 30);
    db.all("SELECT achievement_id FROM user_achievements WHERE tg_id = ?", [tg_id], (err2, ua) => {
      const unlocked = new Set((ua || []).map(a => a.achievement_id));
      db.all("SELECT * FROM achievements", [], (err3, all) => {
        if (err3) return;
        db.get("SELECT COUNT(*) c, COALESCE(SUM(total_volume),0) v FROM workout_logs WHERE tg_id = ?", [tg_id], (err4, w) => {
          db.get("SELECT COUNT(*) c FROM food_logs WHERE tg_id = ?", [tg_id], (err5, m) => {
            calcStreak(tg_id, tz, (streak) => {
              // серия дней с выполненной нормой воды
              let waterStreak = 0;
              db.all("SELECT date, amount_ml FROM water_logs WHERE tg_id = ? ORDER BY date DESC LIMIT 30", [tg_id], (err6, wr) => {
                const wmap = {};
                (wr || []).forEach(r => wmap[r.date] = r.amount_ml);
                for (let i = 0; ; i++) {
                  const d = dateIn(tz, -i);
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
                        // Telegram удалён: достижения видны только в приложении (вкладка «Профиль»)
                        if (err2) console.error('achievement:', err2.message);
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
// --- безопасность без новых зависимостей ---
app.disable('x-powered-by');
// Заголовки безопасности. Приложение больше не работает внутри Telegram, поэтому
// страницу нельзя встроить во фрейм вообще (frame-ancestors 'self').
// Список источников сверен с реальными обращениями самохостингового VK ID SDK
// (id.vk.ru / api.vk.ru / oauth.vk.ru / login.vk.ru) и с local-шрифтами.
// Трекер Top.Mail.ru (mytopf.com), который SDK пытается подгрузить, намеренно
// НЕ разрешён — без согласия пользователя сторонняя аналитика не подключается.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://id.vk.ru https://api.vk.ru https://oauth.vk.ru https://login.vk.ru https://*.vk.ru https://*.vk.com https://*.userapi.com https://*.mycdn.me",
  "frame-src https://id.vk.ru https://oauth.vk.ru https://login.vk.ru https://*.vk.ru https://*.vk.com https://*.vkid.ru https://connect.ok.ru https://*.ok.ru",
  "frame-ancestors 'self'",
  "form-action 'self' https://oauth.vk.ru https://oauth.vk.com https://id.vk.ru",
  "base-uri 'self'",
  "object-src 'none'"
].join('; ');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  // аудит: админку нельзя встроить в iframe (clickjacking с автоподстановкой токена)
  if (req.path === '/admin.html') res.setHeader('X-Frame-Options', 'DENY');
  next();
});
const rlHits = new Map();
app.use('/api', (req, res, next) => {
  const key = req.ip + ':' + req.path;
  const now = Date.now();
  const h = rlHits.get(key) || { n: 0, t: now };
  if (now - h.t > 60000) { h.n = 0; h.t = now; }
  h.n++;
  if (rlHits.size > 20000) { const kill = Math.floor(rlHits.size / 2); let i = 0; for (const k of rlHits.keys()) { if (i++ >= kill) break; rlHits.delete(k); } }
  rlHits.set(key, h);
  if (h.n > 120) return res.status(429).json({ error: 'Too many requests' });
  next();
});
// Health-check реально трогает базу: иначе мониторинг не заметит зависший SQLite
app.get('/api/health', (req, res) => {
  db.get('SELECT 1 AS ok', [], (err) => {
    if (err) { console.error('health db:', err.message); return res.status(503).json({ status: 'degraded', db: 'error' }); }
    // errors — сколько исключений в колбэках/промисах пережил процесс (см. страховку выше):
    // по нему видно, что какой-то запрос падает с ошибкой, хотя сервер отвечает 200
    res.json({ status: 'ok', db: 'ok', version: APP_VERSION, uptime: Math.round(process.uptime()), errors: uncaughtCount });
  });
});

// Версия для Android-обёртки (RuStore: пользователь должен получать уведомление
// о новой версии с рекомендацией обновиться через RuStore).
// MIN_VERSION/FORCE_UPDATE можно задать в .env при критичных обновлениях.
app.get('/api/app-version', (req, res) => {
  res.json({
    latest: APP_VERSION,
    // По умолчанию min = версия сервера: старые сборки получают обязательное обновление.
    // Чтобы обновление было добровольным (кнопка «Позже»), задайте MIN_VERSION ниже текущей.
    min: process.env.MIN_VERSION || APP_VERSION,
    force: process.env.FORCE_UPDATE === '1',
    store: 'https://www.rustore.ru/catalog/app/ru.guidefit.app',
    docs: CONSENT_DOC_VERSION, // редакция privacy.html/terms.html (для повторного согласия)
    message: ''
  });
});

// Общий лимитер для чувствительных запросов (в памяти, без внешних зависимостей):
// true — лимит исчерпан. Один и тот же ключ = один bucket.
const limiterBuckets = new Map();
function isLimited(key, max, windowMs) {
  const now = Date.now();
  const hits = (limiterBuckets.get(key) || []).filter(t => now - t < windowMs);
  if (hits.length >= max) { limiterBuckets.set(key, hits); return true; }
  hits.push(now);
  limiterBuckets.set(key, hits);
  if (limiterBuckets.size > 20000) { const kill = Math.floor(limiterBuckets.size / 2); let i = 0; for (const k of limiterBuckets.keys()) { if (i++ >= kill) break; limiterBuckets.delete(k); } }
  return false;
}

app.post('/api/user/init', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  const { name, goal, gender, age, height, current_weight, target_weight, activity_level, meal_count, consents } = req.body;
  if (!name || !goal || !gender || !age || !height || !current_weight) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  // 152-ФЗ: обработка (включая запись профиля) начинается только после согласий.
  // health = отдельное письменное согласие на данные о здоровье (ст. 10).
  if (!consents || consents.privacy !== true || consents.terms !== true || consents.health !== true) {
    return res.status(403).json({ error: 'Требуется согласие на обработку персональных данных' });
  }
  if (typeof name !== 'string' || !name.trim() || name.length > 100) {
    return res.status(400).json({ error: 'Invalid values' });
  }
  if (!['lose', 'maintain', 'gain'].includes(goal) || !['male', 'female'].includes(gender) ||
      (activity_level && !['sedentary', 'light', 'moderate', 'active', 'very_active'].includes(activity_level))) {
    return res.status(400).json({ error: 'Invalid values' });
  }
  // возраст от 12 лет — согласовано с age-rating приложения и Пользовательским соглашением (п. 8)
  if (!(age >= 12 && age <= 100) || !(height >= 120 && height <= 230) ||
      !(current_weight >= 20 && current_weight <= 400) ||
      (target_weight && !(target_weight >= 20 && target_weight <= 400))) {
    return res.status(400).json({ error: 'Invalid values' });
  }
  const al = activity_level || 'moderate';
  // v26: количество приёмов пищи из онбординга, 2–6, по умолчанию — 2 (раньше молча терялось и на главной был дефолт 4)
  const mcParsed = parseInt(meal_count, 10);
  const mc = (meal_count === undefined || meal_count === null || meal_count === '') ? 2 : mcParsed;
  if (!(mc >= 2 && mc <= 6)) return res.status(400).json({ error: 'Invalid values' });
  const calorie_norm = calcCalories(current_weight, height, age, gender, al, goal);
  // v29: уведомление админу (и дубль в админку) о новой регистрации — только для реально новых аккаунтов.
  // Раньше здесь был db.get("SELECT changes FROM users ...") — такой колонки нет, запрос всегда падал
  // с SQLITE_ERROR, и уведомление о регистрации не приходило НИКОГДА. Теперь признак «новый»
  // определяем заранее: строки ещё нет (Telegram) либо профиль ещё не заполнен (анонимный/VK).
  db.get("SELECT goal FROM users WHERE tg_id = ?", [tgId], (e0, before) => {
    const isNewAccount = !e0 && (!before || !before.goal);
    // v32: created_at пишем в UTC, как и всё остальное время в базе.
    // Раньше разные типы аккаунтов получали разное время: DEFAULT CURRENT_TIMESTAMP
    // давал UTC, а explicit datetime('now','localtime') — МСК; из-за микса админка
    // и отчёт «новых за 7 дней» показывали несравнимые числа.
    db.run(
      `INSERT INTO users (tg_id, name, goal, gender, age, height, current_weight, target_weight, calorie_norm, activity_level, meal_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(tg_id) DO UPDATE SET
         name=excluded.name, goal=excluded.goal, gender=excluded.gender, age=excluded.age,
         height=excluded.height, current_weight=excluded.current_weight,
         target_weight=excluded.target_weight, calorie_norm=excluded.calorie_norm,
         activity_level=excluded.activity_level, meal_count=excluded.meal_count`,
      [tgId, name, goal, gender, age, height, current_weight, target_weight || current_weight, calorie_norm, al, mc],
      (err) => {
        if (err) { console.error(err); return res.status(500).json({ error: 'Database error' }); }
        touchSeen(tgId);
        logConsent(tgId, consents);
        if (isNewAccount) notifyAdminNewUser(tgId, name);
        db.get("SELECT avatar FROM users WHERE tg_id = ?", [tgId], (e2, a2) => {
          res.json({ status: 'ok', calorie_norm, meal_count: mc, avatar: (!e2 && a2 && a2.avatar) || null });
        });
      }
    );
  });
});

app.get('/api/user/:tgId', (req, res, next) => {
  // /api/user/export и /api/user/consent объявлены ниже по файлу: без этой проверки
  // Express принял бы «export»/«consent» за :tgId и вернул профиль вместо нужного
  // маршрута (так и было: выгрузка была недостижима, а редакция согласия — тоже).
  if (req.params.tgId === 'export') return next();
  if (req.params.tgId === 'consent') return next();
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  db.get("SELECT * FROM users WHERE tg_id = ?", [tgId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'User not found' });
    touchSeen(tgId);
    res.json(row);
  });
});

app.post('/api/user/update', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  db.get("SELECT * FROM users WHERE tg_id = ?", [tgId], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const fields = {};
    ['current_weight', 'target_weight', 'goal', 'activity_level', 'name', 'age', 'height', 'timezone', 'fitness_level'].forEach(k => {
      if (req.body[k] !== undefined) fields[k] = req.body[k];
    });
    if (fields.current_weight !== undefined && !(fields.current_weight >= 20 && fields.current_weight <= 400)) return res.status(400).json({ error: 'Invalid values' });
    if (fields.target_weight !== undefined && fields.target_weight !== null && !(fields.target_weight >= 20 && fields.target_weight <= 400)) return res.status(400).json({ error: 'Invalid values' });
    if (fields.age !== undefined && !(fields.age >= 12 && fields.age <= 100)) return res.status(400).json({ error: 'Invalid values' });
    if (fields.height !== undefined && !(fields.height >= 120 && fields.height <= 230)) return res.status(400).json({ error: 'Invalid values' });
    if (fields.goal !== undefined && !['lose', 'maintain', 'gain'].includes(fields.goal)) return res.status(400).json({ error: 'Invalid values' });
    if (fields.activity_level !== undefined && !['sedentary', 'light', 'moderate', 'active', 'very_active'].includes(fields.activity_level)) return res.status(400).json({ error: 'Invalid values' });
    if (fields.fitness_level !== undefined) {
      const fl = parseInt(fields.fitness_level);
      if (!(fl >= 1 && fl <= 5)) return res.status(400).json({ error: 'Invalid values' });
      fields.fitness_level = fl;
    }
    if (fields.name !== undefined && (typeof fields.name !== 'string' || !fields.name.trim() || fields.name.length > 30)) return res.status(400).json({ error: 'Invalid values' });
    if (fields.timezone !== undefined) {
      const tzv = String(fields.timezone);
      if (!tzv || tzv.length > 64 || !/^[A-Za-z0-9_\-+/]+$/.test(tzv)) return res.status(400).json({ error: 'Invalid values' });
      /* Проверка набора символов пропускала имена, которых нет в базе поясов («Foo/Bar»).
         Такое имя сохранялось в профиль, и любой следующий запрос этого пользователя
         падал на Intl с RangeError. Пояс принимаем только настоящий: safeTz() отдаёт
         исходное имя, если оно валидно, и UTC — если нет. */
      if (safeTz(tzv) !== tzv) return res.status(400).json({ error: 'Invalid values' });
    }
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

/* ================= согласие на актуальную редакцию документов (152-ФЗ, ст. 9) =================
   Когда privacy.html/terms.html меняются по существу, прежнее согласие покрывает старую
   редакцию. Приложение при следующем запуске сравнивает свою редакцию с текущей и,
   если они разошлись, просит подтвердить согласие заново — запись уходит в consent_log. */
app.get('/api/user/consent', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  db.get("SELECT doc_version FROM consent_log WHERE tg_id = ? ORDER BY id DESC LIMIT 1", [tgId], (err, row) => {
    if (err) { console.error('consent read:', err.message); return res.status(500).json({ error: 'Database error' }); }
    res.json({ accepted: row ? row.doc_version : null, current: CONSENT_DOC_VERSION });
  });
});

app.post('/api/user/consent', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  const consents = req.body?.consents;
  // все три согласия обязательны — частичное подтверждение новой редакции не принимаем
  if (!consents || consents.privacy !== true || consents.terms !== true || consents.health !== true) {
    return res.status(403).json({ error: 'Требуется согласие на обработку персональных данных' });
  }
  logConsent(tgId, consents);
  res.json({ status: 'ok', doc_version: CONSENT_DOC_VERSION });
});

/* ================= удаление всех данных пользователя (152-ФЗ, ст. 21) ================= */
app.post('/api/user/delete', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  db.serialize(() => {
    db.run("DELETE FROM workout_sets WHERE log_id IN (SELECT id FROM workout_logs WHERE tg_id = ?)", [tgId]);
    db.run("DELETE FROM workout_logs WHERE tg_id = ?", [tgId]);
    db.run("DELETE FROM food_logs WHERE tg_id = ?", [tgId]);
    db.run("DELETE FROM water_logs WHERE tg_id = ?", [tgId]);
    db.run("DELETE FROM weight_logs WHERE tg_id = ?", [tgId]);
    db.run("DELETE FROM user_programs WHERE tg_id = ?", [tgId]);
    // v31: прогресс по новым программам (fit_programs) — отдельная таблица, тоже чистится
    db.run("DELETE FROM user_programs_v2 WHERE tg_id = ?", [tgId]);
    db.run("DELETE FROM user_achievements WHERE tg_id = ?", [tgId]);
    db.run("DELETE FROM support_messages WHERE tg_id = ?", [tgId]);
    // сессии тоже удаляем: иначе токен из localStorage продолжает открывать аккаунт
    db.run("DELETE FROM sessions WHERE tg_id = ?", [tgId]);
    // журнал согласий тоже: без него не остаётся следов ПДн после удаления аккаунта
    db.run("DELETE FROM consent_log WHERE tg_id = ?", [tgId]);
    db.run("DELETE FROM users WHERE tg_id = ?", [tgId], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ status: 'ok' });
    });
  });
});

/* ================= авторизация: VK ID + сессии (standalone/APK) ================= */
const VK_REDIRECT_URI = 'https://app.xn--80aag3axnld9b.xn--p1ai/api/auth/vk/callback';

app.get('/api/auth/providers', (req, res) => {
  res.json({ vk: !!process.env.VK_CLIENT_ID });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.tgUserId) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ tg_id: req.tgUserId });
});

/* ================= анонимная регистрация (без OAuth и без номера телефона) ================= */
// грубый in-memory лимит: не больше 10 анонимных аккаунтов в час с одного IP
const ANON_MAX_PER_HOUR = 10;
const anonHits = new Map();
function anonAllowed(ip) {
  const now = Date.now();
  const hits = (anonHits.get(ip) || []).filter(t => now - t < 3600000);
  if (hits.length >= ANON_MAX_PER_HOUR) { anonHits.set(ip, hits); return false; }
  hits.push(now);
  anonHits.set(ip, hits);
  if (anonHits.size > 20000) { const kill = Math.floor(anonHits.size / 2); let i = 0; for (const k of anonHits.keys()) { if (i++ >= kill) break; anonHits.delete(k); } }
  return true;
}

app.post('/api/auth/anonymous', (req, res) => {
  const ip = req.ip || 'unknown';
  if (!anonAllowed(ip)) return res.status(429).json({ error: 'Слишком много попыток. Попробуйте позже' });
  // tg_id вида 'anon:<hex>'; при коллизии (в теории — 2^72 вариантов) повторяем генерацию
  const create = (attempt) => {
    const tgId = 'anon:' + crypto.randomBytes(9).toString('hex');
    db.get("SELECT 1 AS x FROM users WHERE tg_id = ?", [tgId], (err, row) => {
      if (err) { console.error('anon check:', err.message); return res.status(500).json({ error: 'Database error' }); }
      if (row) { if (attempt < 5) return create(attempt + 1); return res.status(500).json({ error: 'Database error' }); }
      // name намеренно NULL — юзер заполнит его в визарде
      db.run("INSERT INTO users (tg_id, provider, notify_enabled, created_at) VALUES (?, 'anon', 1, datetime('now'))",
        [tgId], (err2) => {
          if (err2) { console.error('anon insert:', err2.message); return res.status(500).json({ error: 'Database error' }); }
          const session = crypto.randomBytes(32).toString('hex');
          db.run("INSERT INTO sessions (token, tg_id, created_at) VALUES (?, ?, ?)",
            [session, tgId, Math.floor(Date.now() / 1000)], (err3) => {
              if (err3) { console.error('anon session:', err3.message); return res.status(500).json({ error: 'Database error' }); }
              res.json({ session });
            });
        });
    });
  };
  create(0);
});

// redirect-режим VKID: топ-окно приходит сюда с code, уводим обратно в приложение
app.get('/api/auth/vk/callback', (req, res) => {
  if (isLimited('vkcb:' + req.ip, 60, 3600000)) return res.status(429).json({ error: 'Too many requests' });
  const code = req.query.code;
  const device_id = req.query.device_id || req.query.deviceId || req.query.deviceID;
  if (!code) return res.status(400).json({ error: 'Missing code' });
  const base = process.env.MINIAPP_URL || '';
  res.redirect(302, base + '/?vkcode=' + encodeURIComponent(code) + (device_id ? '&vkdevice=' + encodeURIComponent(device_id) : ''));
});

function vkForm(params) {
  return Object.entries(params).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v))).join('&');
}

app.post('/api/auth/vk/exchange', async (req, res) => {
  try {
    // обмен кода/токена — чувствительная операция, ограничиваем перебор
    if (isLimited('vkex:' + req.ip, 30, 3600000)) return res.status(429).json({ error: 'Слишком много попыток. Попробуйте позже' });
    const { code, device_id, code_verifier, access_token: directToken } = req.body || {};
    const client_id = process.env.VK_CLIENT_ID, client_secret = process.env.VK_CLIENT_SECRET;
    if (!client_id || !client_secret) { console.error('VK exchange: нет VK_CLIENT_ID/SECRET в .env'); return res.status(502).json({ error: 'VK auth not configured' }); }
    let ex = null, access_token = directToken || null;
    if (!access_token) {
      // режим 1 (виджет): code + PKCE-verifier меняем на токены на бэкенде
      if (!code || !device_id || !code_verifier) return res.status(400).json({ error: 'Missing fields' });
      let exRes;
      try {
        exRes = await fetch('https://id.vk.ru/oauth2/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: vkForm({ grant_type: 'authorization_code', code, client_id, client_secret, device_id, redirect_uri: VK_REDIRECT_URI, code_verifier }),
          signal: AbortSignal.timeout(15000)
        });
        ex = await exRes.json().catch(() => ({}));
      } catch (e) { console.error('VK exchange fetch:', e.message); return res.status(502).json({ error: 'VK exchange failed' }); }
      if (!exRes.ok || !ex.access_token) { console.error('VK exchange failed:', exRes.status, JSON.stringify(ex).slice(0, 300)); return res.status(502).json({ error: 'VK exchange failed' }); }
      access_token = ex.access_token;
    }
    // фото из VK (avatar). Имя НЕ читаем и НЕ сохраняем: юзер вводит его сам в визарде.
    const avCands = [];
    const pushAv = (v) => { if (typeof v === 'string' && /^https?:\/\//.test(v)) avCands.push(v.slice(0, 500)); };
    let vkId = (ex && ex.user_id) ? String(ex.user_id) : null;
    try {
      const uiRes = await fetch('https://id.vk.ru/oauth2/user_info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: vkForm({ client_id, access_token }),
        signal: AbortSignal.timeout(15000)
      });
      const ui = await uiRes.json().catch(() => ({}));
      if (ui && ui.user) {
        if (ui.user.user_id) vkId = String(ui.user.user_id);
        pushAv(ui.user.avatar); pushAv(ui.user.photo); pushAv(ui.user.picture); pushAv(ui.user.user_photo);
      }
    } catch (e) { console.error('VK user_info:', e.message); }
    if (ex && ex.id_token) {
      try {
        const payload = JSON.parse(Buffer.from(String(ex.id_token).split('.')[1], 'base64').toString('utf8'));
        if (payload && payload.user_id) vkId = String(payload.user_id);
        pushAv(payload.picture); pushAv(payload.photo); pushAv(payload.avatar);
      } catch (e) { console.error('VK id_token decode:', e.message); }
    }
    const vkAvatar = avCands[0] || null;
    if (!vkId) { console.error('VK exchange: нет user_id'); return res.status(502).json({ error: 'VK exchange failed' }); }
    const tgId = 'vk:' + vkId;
    const now = Math.floor(Date.now() / 1000);
    await new Promise((resolve, reject) => {
      db.run(`INSERT INTO users (tg_id, avatar, provider, created_at, notify_enabled)
        VALUES (?, ?, 'vk', datetime('now'), 1)
        ON CONFLICT(tg_id) DO UPDATE SET
          avatar = CASE WHEN excluded.avatar IS NULL OR excluded.avatar = '' THEN users.avatar ELSE excluded.avatar END,
          last_seen = datetime('now')`,
        [tgId, vkAvatar], (e) => e ? reject(e) : resolve());
    });
    // Если человек пользовался анонимным аккаунтом и потом вошёл через ВК — переносим прогресс,
    // чтобы данные не потерялись (это и есть обещанное в интерфейсе «прогресс не потеряется»).
    let merged = false;
    if (req.tgUserId && /^anon:/.test(String(req.tgUserId)) && req.tgUserId !== tgId) {
      await new Promise((resolve) => mergeAnonymousInto(req.tgUserId, tgId, (ok) => { merged = ok; resolve(); }));
    }
    const session = crypto.randomBytes(32).toString('hex');
    await new Promise((resolve, reject) => {
      db.run("INSERT INTO sessions (token, tg_id, created_at) VALUES (?, ?, ?)",
        [session, tgId, now], (e) => e ? reject(e) : resolve());
    });
    res.json({ session, merged });
  } catch (e) { console.error('VK exchange:', e.message); return res.status(502).json({ error: 'VK exchange failed' }); }
});

/* ================= перенос прогресса анонимного аккаунта в аккаунт ВК ================= */
function mergeAnonymousInto(fromId, toId, cb) {
  if (typeof cb !== 'function') return missingCallback('mergeAnonymousInto');
  if (!fromId || !toId || fromId === toId || !/^anon:/.test(String(fromId))) return cb(false);
  db.get("SELECT * FROM users WHERE tg_id = ?", [fromId], (e0, src) => {
    if (e0 || !src) return cb(false);
    if (!src.goal) return cb(false); // анонимный аккаунт не заполнен — переносить нечего
    db.get("SELECT * FROM users WHERE tg_id = ?", [toId], (e1, tgt) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        db.run("DELETE FROM sessions WHERE tg_id = ?", [fromId]);
        db.run("DELETE FROM users WHERE tg_id = ?", [fromId], () => cb(true));
      };
      db.serialize(() => {
        // вода и вес — с учётом UNIQUE(tg_id, date): дубли аккуратно отбрасываем
        db.run("INSERT OR IGNORE INTO water_logs (tg_id, date, amount_ml) SELECT ?, date, amount_ml FROM water_logs WHERE tg_id = ?", [toId, fromId]);
        db.run("DELETE FROM water_logs WHERE tg_id = ?", [fromId]);
        db.run("INSERT OR IGNORE INTO weight_logs (tg_id, date, weight) SELECT ?, date, weight FROM weight_logs WHERE tg_id = ?", [toId, fromId]);
        db.run("DELETE FROM weight_logs WHERE tg_id = ?", [fromId]);
        db.run("UPDATE food_logs SET tg_id = ? WHERE tg_id = ?", [toId, fromId]);
        db.run("INSERT OR IGNORE INTO user_achievements (tg_id, achievement_id, unlocked_at) SELECT ?, achievement_id, unlocked_at FROM user_achievements WHERE tg_id = ?", [toId, fromId]);
        db.run("DELETE FROM user_achievements WHERE tg_id = ?", [fromId]);
        db.run("UPDATE user_programs SET tg_id = ? WHERE tg_id = ?", [toId, fromId]);
        // профиль переносим только если у аккаунта ВК его ещё нет — чужие данные не затираем
        if (!tgt || !tgt.goal) {
          db.run(`UPDATE users SET name = ?, goal = ?, gender = ?, age = ?, height = ?, current_weight = ?,
              target_weight = ?, calorie_norm = ?, activity_level = ?, meal_count = ? WHERE tg_id = ?`,
            [src.name, src.goal, src.gender, src.age, src.height, src.current_weight,
             src.target_weight, src.calorie_norm, src.activity_level, src.meal_count, toId]);
        }
        // тренировки: у них есть дочерние подходы — переносим поштучно, чтобы sets не осиротели
        db.all("SELECT id, program_id, program_day_id, date, duration_minutes, total_volume, notes, completed FROM workout_logs WHERE tg_id = ?", [fromId], (e2, logs) => {
          const rows = logs || [];
          let i = 0;
          const step = () => {
            if (i >= rows.length) return finish();
            const L = rows[i++];
            db.run(`INSERT INTO workout_logs (tg_id, program_id, program_day_id, date, duration_minutes, total_volume, notes, completed)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [toId, L.program_id, L.program_day_id, L.date, L.duration_minutes, L.total_volume, L.notes, L.completed == null ? 1 : L.completed],
              function (e3) {
                if (e3) { console.error('merge workout:', e3.message); return step(); }
                const newId = this.lastID;
                db.run("UPDATE workout_sets SET log_id = ? WHERE log_id = ?", [newId, L.id], () =>
                  db.run("DELETE FROM workout_logs WHERE id = ?", [L.id], () => step()));
              });
          };
          step();
        });
      });
    });
  });
}

/* ================= экспорт данных пользователя (право на доступ, 152-ФЗ ст. 14/20) ================= */
// v28: одноразовый токен скачивания — файл отдаётся обычным GET с Content-Disposition,
// поэтому скачивание работает и в WebView Android-приложения (где a[download] для blob часто запрещён)
const exportTokens = new Map();
app.post('/api/user/export/token', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  const t = crypto.randomBytes(24).toString('hex');
  exportTokens.set(t, { tgId, exp: Date.now() + 120000 });
  if (exportTokens.size > 1000) { const kill = Math.floor(exportTokens.size / 2); let i = 0; for (const k of exportTokens.keys()) { if (i++ >= kill) break; exportTokens.delete(k); } }
  res.json({ token: t });
});
app.get('/api/user/export', (req, res) => {
  let tgId = null;
  const dtTok = String(req.query.dt || '');
  if (dtTok) {
    const rec = exportTokens.get(dtTok);
    if (rec && rec.exp > Date.now()) { tgId = rec.tgId; exportTokens.delete(dtTok); }
  }
  if (!tgId) tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  if (req.query.download) res.setHeader('Content-Disposition', 'attachment; filename="guidefit-dannye.json"');
  db.get("SELECT * FROM users WHERE tg_id = ?", [tgId], (e0, u) => {
    if (e0) { console.error('export user:', e0.message); return res.status(500).json({ error: 'Database error' }); }
    if (!u) return res.status(404).json({ error: 'User not found' });
    // в выгрузке время показываем в поясе пользователя (в базе — UTC), иначе
    // в своём же архиве человек не узнавал, когда что записал
    db.all(`SELECT datetime(fl.timestamp, ?) AS timestamp, r.title, r.category, r.calories, r.protein, r.fat, r.carbs
        FROM food_logs fl LEFT JOIN recipes r ON fl.recipe_id = r.id WHERE fl.tg_id = ? ORDER BY fl.timestamp`, [userTzMod(req), tgId], (e1, meals) => {
      db.all("SELECT date, amount_ml FROM water_logs WHERE tg_id = ? ORDER BY date", [tgId], (e2, water) => {
        db.all("SELECT date, weight FROM weight_logs WHERE tg_id = ? ORDER BY date", [tgId], (e3, weights) => {
          db.all("SELECT date, duration_minutes, total_volume, notes FROM workout_logs WHERE tg_id = ? ORDER BY date", [tgId], (e4, workouts) => {
            db.all("SELECT achievement_id FROM user_achievements WHERE tg_id = ?", [tgId], (e5, ach) => {
              db.all("SELECT program_id, start_date, current_week, current_day, active, completed FROM user_programs WHERE tg_id = ?", [tgId], (e6, progs) => {
                res.json({
                  service: 'GuideFit',
                  exported_at: new Date().toISOString(),
                  note: 'Копия ваших данных из приложения GuideFit (Политика обработки персональных данных: /privacy.html)',
                  profile: {
                    id: u.tg_id,
                    provider: u.provider || 'anon',
                    name: u.name,
                    gender: u.gender,
                    age: u.age,
                    height: u.height,
                    current_weight: u.current_weight,
                    target_weight: u.target_weight,
                    goal: u.goal,
                    activity_level: u.activity_level,
                    calorie_norm: u.calorie_norm,
                    meal_count: u.meal_count,
                    notifications_enabled: !!u.notify_enabled,
                    created_at: u.created_at,
                    last_seen: u.last_seen
                  },
                  meals: meals || [],
                  water: water || [],
                  weights: weights || [],
                  workouts: workouts || [],
                  programs: progs || [],
                  achievements: ach || []
                });
              });
            });
          });
        });
      });
    });
  });
});

/* ================= админка (ADMIN_TOKEN в .env) ================= */
function requireAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return res.status(403).json({ error: 'Admin disabled' });
  const got = String(req.headers['x-admin-token'] || '');
  const a = Buffer.from(got), b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).json({ error: 'Forbidden' });
  next();
}

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  // Сводка админки — глобальная, без пояса конкретного пользователя: считаем по поясу сервера.
  const today = dateIn(APP_TZ);
  const tzMod = tzModifier(APP_TZ);
  db.get("SELECT COUNT(*) c FROM users", [], (e1, u) => {
    db.get("SELECT COUNT(*) c FROM users WHERE date(last_seen, ?) = ?", [tzMod, today], (e2, t) => {
      db.get("SELECT COUNT(*) c FROM users WHERE date(last_seen, ?) >= date('now', ?, '-7 days')", [tzMod, tzMod], (e3, w) => {
        db.get("SELECT COUNT(*) c FROM users WHERE date(created_at, ?) >= date('now', ?, '-7 days')", [tzMod, tzMod], (e4, n) => {
          if (e1 || e2 || e3 || e4) return res.status(500).json({ error: 'Database error' });
          res.json({ users: u.c, activeToday: t.c, active7d: w.c, new7d: n.c });
        });
      });
    });
  });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const q = String(req.query.search || '').trim();
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const where = q ? "WHERE tg_id LIKE ? OR name LIKE ?" : "";
  const args = q ? ['%' + q + '%', '%' + q + '%'] : [];
  db.get("SELECT COUNT(*) c FROM users " + where, args, (e1, cnt) => {
    if (e1) return res.status(500).json({ error: e1.message });
    db.all(`SELECT u.tg_id, u.name, u.provider, u.goal, u.gender, u.age, u.calorie_norm, u.meal_count,
        u.created_at, u.last_seen,
        (SELECT COUNT(*) FROM workout_logs w WHERE w.tg_id = u.tg_id) AS workouts,
        (SELECT COUNT(*) FROM food_logs f WHERE f.tg_id = u.tg_id) AS meals
      FROM users u ${where} ORDER BY datetime(COALESCE(u.last_seen, u.created_at)) DESC LIMIT ? OFFSET ?`,
      [...args, limit, offset], (e2, rows) => {
        if (e2) return res.status(500).json({ error: e2.message });
        res.json({ total: cnt.c, users: rows || [] });
      });
  });
});

app.get('/api/admin/user/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id || '');
  db.get("SELECT * FROM users WHERE tg_id = ?", [id], (e1, user) => {
    if (e1) return res.status(500).json({ error: e1.message });
    if (!user) return res.status(404).json({ error: 'Not found' });
    db.all("SELECT timestamp, recipe_id FROM food_logs WHERE tg_id = ? ORDER BY timestamp DESC LIMIT 10", [id], (e2, meals) => {
      db.all("SELECT date, duration_minutes, total_volume FROM workout_logs WHERE tg_id = ? ORDER BY date DESC LIMIT 10", [id], (e3, workouts) => {
        db.all("SELECT date, weight FROM weight_logs WHERE tg_id = ? ORDER BY date DESC LIMIT 10", [id], (e4, weights) => {
          res.json({ user, meals: meals || [], workouts: workouts || [], weights: weights || [] });
        });
      });
    });
  });
});

/* ================= админка: диалоги поддержки (v28) ================= */
app.get('/api/admin/support/threads', requireAdmin, (req, res) => {
  db.all(`SELECT sm.tg_id, u.name,
      (SELECT text FROM support_messages m2 WHERE m2.tg_id = sm.tg_id ORDER BY m2.id DESC LIMIT 1) AS last_text,
      (SELECT datetime(m3.created_at,'localtime') FROM support_messages m3 WHERE m3.tg_id = sm.tg_id ORDER BY m3.id DESC LIMIT 1) AS last_time
    FROM support_messages sm LEFT JOIN users u ON u.tg_id = sm.tg_id
    GROUP BY sm.tg_id ORDER BY MAX(sm.id) DESC LIMIT 200`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ threads: rows || [] });
  });
});

app.get('/api/admin/support/thread/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id || '');
  db.all("SELECT id, sender, text, datetime(created_at,'localtime') AS time FROM support_messages WHERE tg_id = ? ORDER BY id ASC LIMIT 500", [id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get("SELECT name FROM users WHERE tg_id = ?", [id], (e2, u) => {
      res.json({ tg_id: id, name: (u && u.name) || '', messages: rows || [] });
    });
  });
});

app.post('/api/admin/support/reply', requireAdmin, (req, res) => {
  const id = String(req.body?.tg_id || '');
  const text = String(req.body?.text || '').trim();
  if (!id || !text) return res.status(400).json({ error: 'Missing fields' });
  if (text.length > 1500) return res.status(400).json({ error: 'Слишком длинное сообщение' });
  db.run("INSERT INTO support_messages (tg_id, sender, text) VALUES (?, 'admin', ?)", [id, text], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    // Telegram удалён: ответ админа пользователь видит в чате поддержки приложения
    // (вкладка «Поддержка» опрашивает сервер раз в 15 секунд, пока открыта)
    res.json({ status: 'ok', id: this.lastID });
  });
});

/* ================= чат поддержки (встроенный) =================
   v28: сообщения пользователя хранятся в БД с привязкой к аккаунту; ответ админа
   появляется в чате приложения. Telegram удалён — уведомления о новых сообщениях
   админ видит в админ-панели. */

app.post('/api/support/message', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
  if (text.length > 1500) return res.status(400).json({ error: 'Слишком длинное сообщение' });
  if (isLimited('support:' + tgId, 20, 3600000)) return res.status(429).json({ error: 'Слишком много сообщений. Попробуйте позже' });
  db.run("INSERT INTO support_messages (tg_id, sender, text) VALUES (?, 'user', ?)", [tgId, text], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ status: 'ok', id: this.lastID });
  });
});

app.get('/api/support/messages', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  // sender <> 'system' — служебные записи (уведомление о регистрации для админа) пользователю не показываем
  // время сообщений показываем в поясе пользователя (в базе — UTC)
  db.all("SELECT id, sender, text, datetime(created_at, ?) AS time FROM support_messages WHERE tg_id = ? AND sender <> 'system' ORDER BY id DESC LIMIT 100", [userTzMod(req), tgId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ messages: (rows || []).reverse() });
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

app.get('/api/ex-photo', async (req, res) => {
  try{
    const q = String(req.query.q || '').slice(0, 80);
    if(!q) return res.json({ url: null });
    const slug = crypto.createHash('md5').update(q).digest('hex').slice(0, 16) + '.webp';
    const localPath = path.join(IMG_DIR, slug);
    const localUrl = '/images/cache/' + slug;
    // 1) уже скачано ранее — отдаём локальный файл, Pexels не трогаем
    if (fs.existsSync(localPath)) return res.json({ url: localUrl, cached: true });
    const key = process.env.PEXELS_API_KEY;
    if(!key) return res.json({ url: null });
    const r = await fetch('https://api.pexels.com/v1/search?query=' + encodeURIComponent(q) + '&per_page=1&orientation=landscape', { headers: { Authorization: key } });
    const d = await r.json();
    const url = (d.photos && d.photos[0]) ? d.photos[0].src.medium : null;
    if(!url) return res.json({ url: null });
    // 2) первый запрос — скачиваем, сжимаем в webp и сохраняем на диск
    const local = await cacheImageLocally(url, q);
    res.json({ url: local || url, cached: !!local });
  }catch(e){ res.json({ url: null }); }
});

/* ================= статистика и дашборд ================= */
app.get('/api/stats/:tgId', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  /* Недельная сетка и «сегодня» — в поясе пользователя (день недели берём из его
     даты, а не из серверной). */
  const tzMod = userTzMod(req);
  const today = userDay(req);
  const dayOfWeek = new Date(today + 'T00:00:00').getDay() || 7;
  const days = [];
  for (let i = 0; i < 7; i++) days.push(userDay(req, i - dayOfWeek + 1));
  db.get("SELECT calorie_norm, current_weight FROM users WHERE tg_id = ?", [tgId], (err, user) => {
    if (err) console.error('stats user:', err.message);
    const target = user?.calorie_norm || 2000;
    const currentWeight = user?.current_weight || null;
    const placeholders = days.map(() => '?').join(',');
    db.all(`SELECT date(fl.timestamp, ?) as dt, SUM(r.calories) as cals
        FROM food_logs fl JOIN recipes r ON fl.recipe_id = r.id
        WHERE fl.tg_id = ? AND date(fl.timestamp, ?) IN (${placeholders})
        GROUP BY date(fl.timestamp, ?)`, [tzMod, tgId, tzMod, ...days, tzMod], (err, calRows) => {
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
    touchSeen(tgId);
    const today = userDay(req);
    db.all(`SELECT r.* FROM food_logs fl JOIN recipes r ON fl.recipe_id = r.id
        WHERE fl.tg_id = ? AND date(fl.timestamp, ?) = ?`, [tgId, userTzMod(req), today], (err, meals) => {
      if (err) console.error('dashboard meals:', err.message);
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
              const hour = userHour(req);
              let nextMeal = 'breakfast';
              if (hour >= 10) nextMeal = 'lunch';
              if (hour >= 15) nextMeal = 'snack';
              if (hour >= 18) nextMeal = 'dinner';
              // пояс обязателен: calcStreak(tg_id, tz, callback) считает серию днями ПОЛЬЗОВАТЕЛЯ.
              // Без него tz получал callback, а сам callback оставался undefined —
              // TypeError в колбэке SQLite ронял весь процесс (exit 1) на каждом
              // открытии главного экрана аккаунта без тренировок.
              calcStreak(tgId, user.timezone || APP_TZ, (streak) => {
                res.json({
                  streak,
                  consumption,
                  norms: calcNorms(user),
                  user,
                  meal_count: user.meal_count,
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
// v23: селектор блюд доступен и без авторизации (гость выбирает рецепт до логина);
// запись в дневник по-прежнему требует tg_id
app.post('/api/meal', (req, res) => {
  const { category, exclude_id } = req.body;
  // приёмы пищи — фиксированный набор из 4 категорий (никаких других не существует)
  const MEALS = new Set(['breakfast', 'lunch', 'dinner', 'snack']);
  if (!category || !MEALS.has(category)) return res.status(400).json({ error: 'Missing category' });
  const GOALS = new Set(['lose', 'maintain', 'gain']);
  const goalSafe = (typeof req.body.goal === 'string' && GOALS.has(req.body.goal)) ? req.body.goal : null;

  /* ===== КЛЮЧЕВАЯ ЛОГИКА: диапазон калорий приёма пищи из профиля =====
     1) Профиль: авторизованный (сессия/Telegram) — читаем из БД; гость — фолбэк 2000 ккал / 4 приёма.
     2) Базовая доля приёма от дневной нормы: завтрак 25%, обед 35%, ужин 25%, перекус 15%
        (совпадает с планом генерации каталога scripts/gen-pp-dishes.js).
     3) Масштабирование под число приёмов (meal_count из визарда): target = норма * доля * 4 / meal_count
        (при 3 приёмах каждый крупнее, при 5 — мельче; перекус не масштабируем).
     4) Диапазон = target ±20%; цель сужает его: «похудение» — нижняя половина, «набор» — верхняя.
     5) Пусто → расширение на 15% (fallback), затем подбор по категории без потолка. */
  const tgId = resolveTgId(req);
  const pickWith = (user) => {
    const norm = Math.max(1200, Math.min(6000, Math.round(Number(user && user.calorie_norm) || 2000)));
    const mc = Math.max(2, Math.min(6, parseInt(user && user.meal_count, 10) || 4));
    const goal = goalSafe || (user && GOALS.has(user.goal) ? user.goal : 'maintain');
    const share = { breakfast: 0.25, lunch: 0.35, dinner: 0.25, snack: 0.15 }[category];
    const target = Math.round(norm * share * (category === 'snack' ? 1 : 4 / mc));
    let lo = Math.round(target * 0.8), hi = Math.round(target * 1.2);
    if (goal === 'lose') hi = Math.min(hi, target);
    if (goal === 'gain') lo = Math.max(lo, target);
    const serve = (row) => {
      if (row.ingredients) try { row.ingredients = JSON.parse(row.ingredients); } catch (e) {}
      if (row.recipe_steps) try { row.recipe_steps = JSON.parse(row.recipe_steps); } catch (e) {}
      res.json({ recipe: row, meal_target: target, meal_range: [lo, hi] });
    };
    const attempt = (loV, hiV, withExclude) => {
      let sql2 = "SELECT * FROM recipes WHERE category = ?";
      const p2 = [category];
      if (loV > 0) { sql2 += " AND calories >= ?"; p2.push(loV); }
      if (hiV) { sql2 += " AND calories <= ?"; p2.push(hiV); }
      if (withExclude && exclude_id) { sql2 += " AND id != ?"; p2.push(exclude_id); }
      sql2 += " ORDER BY RANDOM() LIMIT 1";
      db.get(sql2, p2, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) return serve(row);
        if (hiV) return attempt(Math.round(loV * 0.85), Math.round(hiV * 1.15), withExclude); // fallback +15%
        if (withExclude) return attempt(0, null, false); // «Другое» не падает в 404
        return res.status(404).json({ error: 'Recipe not found' });
      });
    };
    attempt(lo, hi, true);
  };
  if (!tgId) return pickWith(null);
  db.get("SELECT calorie_norm, meal_count, goal FROM users WHERE tg_id = ?", [tgId], (e, u) => pickWith(e ? null : u));
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
  const recipe_id = parseInt(req.body?.recipe_id, 10);
  if (!recipe_id) return res.status(400).json({ error: 'Missing fields' });
  // без проверки каталога в дневник писался любой id и запись молча терялась в JOIN дашборда
  db.get("SELECT 1 AS x FROM recipes WHERE id = ?", [recipe_id], (e0, r0) => {
    if (e0) return res.status(500).json({ error: e0.message });
    if (!r0) return res.status(404).json({ error: 'Recipe not found' });
    // время пишем в UTC: 'день' записи считается по поясу пользователя при чтении
    db.run("INSERT INTO food_logs (tg_id, recipe_id, timestamp) VALUES (?, ?, datetime('now'))",
      [tgId, recipe_id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        bumpAchievements(tgId);
        touchSeen(tgId);
        res.json({ status: 'ok' });
      });
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
  // timestamp в базе — UTC, поэтому день пользователя получаем модификатором пояса
  db.all(`SELECT fl.id as log_id, r.*, fl.timestamp
      FROM food_logs fl JOIN recipes r ON fl.recipe_id = r.id
      WHERE fl.tg_id = ? AND date(fl.timestamp, ?) = ?
      ORDER BY fl.timestamp DESC`, [tgId, userTzMod(req), userDay(req)], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ meals: rows || [] });
  });
});

app.get('/api/shopping-list/:tgId', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  const tzMod = userTzMod(req);
  db.all(`SELECT r.ingredients FROM food_logs f JOIN recipes r ON f.recipe_id = r.id
      WHERE f.tg_id = ? AND date(f.timestamp, ?) >= date('now', ?, '-7 days')`,
    [tgId, tzMod, tzMod], (err, rows) => {
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
  const weekAgo = userDay(req, -7);
  const tzMod = userTzMod(req);
  db.all("SELECT date, duration_minutes, total_volume FROM workout_logs WHERE tg_id = ? AND date >= ? ORDER BY date",
    [tgId, weekAgo], (err, workouts) => {
      db.all("SELECT date, weight FROM weight_logs WHERE tg_id = ? AND date >= ? ORDER BY date",
        [tgId, weekAgo], (err, weights) => {
          db.all(`SELECT r.calories FROM food_logs fl JOIN recipes r ON fl.recipe_id = r.id
              WHERE fl.tg_id = ? AND date(fl.timestamp, ?) >= ?`, [tgId, tzMod, weekAgo], (err, meals) => {
            const totalMinutes = (workouts || []).reduce((s, w) => s + (w.duration_minutes || 0), 0);
            const totalVolume = (workouts || []).reduce((s, w) => s + (w.total_volume || 0), 0);
            const avgCals = meals?.length ? Math.round(meals.reduce((s, m) => s + (m.calories || 0), 0) / 7) : 0;
            const weightChange = weights?.length >= 2 ? Number((weights[weights.length - 1].weight - weights[0].weight).toFixed(1)) : 0;
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
    attachGifs(rows, () => res.json({ exercises: rows }));
  });
});

app.get('/api/exercise/:id', (req, res) => {
  db.get("SELECT * FROM exercises WHERE id = ?", [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Not found' });
    row.tips = Array.isArray(row.tips) ? row.tips : (row.tips ? [row.tips] : []);
    attachGifs([row], () => res.json(row));
  });
});

/* v31: добавляет gif_url из meta (упавшему в кеш списку — один SQL-запрос вместо N) */
let _gifMetaCache = null, _gifMetaAt = 0;
function gifMap(cb) {
  if (typeof cb !== 'function') return missingCallback('gifMap');
  if (_gifMetaCache && Date.now() - _gifMetaAt < 300000) return cb(_gifMetaCache);
  db.all("SELECT key, value FROM meta WHERE key LIKE 'exercise:gif:%' AND key != 'exercise:gif:source'", [], (e, rows) => {
    const m = {};
    (rows || []).forEach(r => { try { m[r.key.replace('exercise:gif:', '')] = JSON.parse(r.value).gif || null; } catch (er) {} });
    _gifMetaCache = m; _gifMetaAt = Date.now();
    cb(m);
  });
}
function attachGifs(rows, done) {
  if (typeof done !== 'function') return missingCallback('attachGifs');
  gifMap(m => { (rows || []).forEach(r => { r.gif_url = m[r.id] || null; }); done(); });
}

/* v31: медиа упражнения — локальная GIF-анимация (© Gym visual, exercises-dataset),
   при отсутствии пары в датасете — фото с Pexels (существующий пайплайн кеша). */
app.get('/api/exercise-media/:id', async (req, res) => {
  try {
    const exId = parseInt(req.params.id, 10) || 0;
    const name = String(req.query.name || '').slice(0, 80);
    let gifUrl = null, source = 'gif';
    if (exId) {
      const row = await new Promise((resolve) =>
        db.get("SELECT value FROM meta WHERE key = ?", ['exercise:gif:' + exId], (e, r) => resolve(r)));
      if (row) { try { gifUrl = JSON.parse(row.value).gif || null; } catch (e) {} }
    }
    if (!gifUrl) {
      source = 'photo';
      const q = name || 'gym workout training';
      const slug = crypto.createHash('md5').update('ex:' + q).digest('hex').slice(0, 16) + '.webp';
      const localPath = path.join(IMG_DIR, slug);
      if (fs.existsSync(localPath)) gifUrl = '/images/cache/' + slug;
      else {
        const remote = await fetchPexelsPhoto(q + ' exercise training');
        if (remote) {
          const local = await cacheImageLocally(remote, 'ex:' + q);
          gifUrl = local || remote;
        }
      }
    }
    res.json({ url: gifUrl || '', source });
  } catch (e) { res.json({ url: '', source: 'none' }); }
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
      if (err) return res.status(500).json({ error: err.message });
      if (!days || !days.length) return res.json({ program, days: [], total_days: 0 });
      const fetchExercises = (index) => {
        if (index >= days.length) return res.json({ program, days, total_days: days.length });
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
        VALUES (?, ?, ?, 1, 1, 1)`, [tgId, program_id, userDay(req)], (err) => {
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
    if (err) return res.status(500).json({ error: err.message });
    if (!up) return res.status(404).json({ error: 'No active program' });
    db.all("SELECT * FROM program_days WHERE program_id = ? ORDER BY week, day", [up.program_id], (err, days) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!days || !days.length) return res.status(404).json({ error: 'No program days' });
      const idx = days.findIndex(d => d.week === up.current_week && d.day === up.current_day);
      if (idx === -1) return res.status(404).json({ error: 'Current day not found' });
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

/* ================= v31: новая система программ (Фаза B) =================
   fit_programs (fat/muscle/cardio) + yoga_programs (5 уровней, фокусы).
   Старые /api/programs и /api/yoga/* остаются нетронутыми для отката. */
const GOAL_TO_CATEGORY = { lose: 'fat', gain: 'muscle', maintain: 'cardio' };
function exerciseMedia(exerciseId) {
  return new Promise((resolve) => {
    db.get("SELECT value FROM meta WHERE key = ?", ['exercise:gif:' + exerciseId], (e, r) => resolve((r && r.value) || null));
  });
}
function yogaPoseMedia(poseId) {
  return new Promise((resolve) => {
    db.get("SELECT value FROM meta WHERE key = ?", ['exercise:gif:yoga:' + poseId], (e, r) => resolve((r && r.value) || null));
  });
}

app.get('/api/fit/programs', async (req, res) => {
  const cat = ['fat', 'muscle', 'cardio'].includes(req.query.category) ? req.query.category : null;
  const lvl = [1, 2, 3, 4, 5].includes(parseInt(req.query.level)) ? parseInt(req.query.level) : null;
  let sql = "SELECT * FROM fit_programs WHERE 1=1";
  const params = [];
  if (cat) { sql += " AND category = ?"; params.push(cat); }
  if (lvl) { sql += " AND level = ?"; params.push(lvl); }
  sql += " ORDER BY level, id";
  db.all(sql, params, async (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    // рекомендация по цели профиля (гость/без цели -> fat, как в ТЗ)
    let recommended = 'fat';
    const tgId = resolveTgId(req);
    if (tgId) {
      const u = await new Promise((resolve) => db.get("SELECT goal FROM users WHERE tg_id = ?", [tgId], (e, r) => resolve(r)));
      if (u && GOAL_TO_CATEGORY[u.goal]) recommended = GOAL_TO_CATEGORY[u.goal];
    }
    res.json({ programs: rows, recommended });
  });
});

app.get('/api/fit/program/:id', (req, res) => {
  db.get("SELECT * FROM fit_programs WHERE id = ?", [req.params.id], (err, program) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!program) return res.status(404).json({ error: 'Not found' });
    db.all("SELECT * FROM fit_days WHERE program_id = ? ORDER BY week, day", [program.id], async (err2, days) => {
      if (err2) return res.status(500).json({ error: err2.message });
      const enriched = await Promise.all((days || []).map(d => new Promise((resolve) => {
        db.all(`SELECT fe.*, e.name as exercise_name, e.description as exercise_desc, e.muscle_group
              FROM fit_exercises fe JOIN exercises e ON e.id = fe.exercise_id
              WHERE fe.program_day_id = ? ORDER BY fe.id`, [d.id], async (err3, exes) => {
          const list = exes || [];
          await Promise.all(list.map(async (x) => { x.gif_url = await exerciseMedia(x.exercise_id); }));
          resolve({ ...d, exercises: list });
        });
      })));
      res.json({ program, days: enriched, total_days: enriched.length });
    });
  });
});

app.post('/api/fit/start', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  const pid = parseInt(req.body.program_id);
  if (!pid) return res.status(400).json({ error: 'Missing fields' });
  db.get("SELECT id FROM fit_programs WHERE id = ?", [pid], (err, p) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!p) return res.status(404).json({ error: 'Not found' });
    db.get("SELECT id FROM fit_days WHERE program_id = ? ORDER BY week, day LIMIT 1", [pid], (err2, d) => {
      if (err2) return res.status(500).json({ error: err2.message });
      if (!d) return res.status(404).json({ error: 'Program has no days' });
      db.run("UPDATE user_programs_v2 SET active = 0 WHERE tg_id = ?", [tgId], () => {
        db.run(`INSERT INTO user_programs_v2 (tg_id, program_id, current_day_id, start_date, active)
              VALUES (?, ?, ?, ?, 1)`, [tgId, pid, d.id, userDay(req)], (err3) => {
          if (err3) return res.status(500).json({ error: err3.message });
          touchSeen(tgId);
          res.json({ status: 'ok' });
        });
      });
    });
  });
});

app.get('/api/fit/active', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  db.get(`SELECT upv.*, fp.name as program_name, fp.category, fp.level, fp.weeks, fp.days_per_week, fp.description
      FROM user_programs_v2 upv JOIN fit_programs fp ON fp.id = upv.program_id
      WHERE upv.tg_id = ? AND upv.active = 1`, [tgId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.json({ program: null });
    db.get("SELECT COUNT(*) c FROM fit_days WHERE program_id = ?", [row.program_id], (err2, c) => {
      if (err2) return res.status(500).json({ error: err2.message });
      db.get("SELECT week, day, title FROM fit_days WHERE id = ?", [row.current_day_id], (err3, cur) => {
        if (err3) return res.status(500).json({ error: err3.message });
        // выполненные дни: по фактическим логам тренировок (finishWorkout пишет program_day_id)
        db.all("SELECT DISTINCT program_day_id FROM workout_logs WHERE tg_id = ? AND program_day_id IN (SELECT id FROM fit_days WHERE program_id = ?)",
          [tgId, row.program_id], (err4, doneRows) => {
            if (err4) return res.status(500).json({ error: err4.message });
            row.total_days = (c && c.c) || 0;
            row.current = cur || null;
            row.done_day_ids = (doneRows || []).map(x => x.program_day_id);
            res.json({ program: row });
          });
      });
    });
  });
});

app.post('/api/fit/progress', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  db.get("SELECT * FROM user_programs_v2 WHERE tg_id = ? AND active = 1", [tgId], (err, up) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!up) return res.status(404).json({ error: 'No active program' });
    db.all("SELECT id FROM fit_days WHERE program_id = ? ORDER BY week, day", [up.program_id], (err2, days) => {
      if (err2) return res.status(500).json({ error: err2.message });
      const idx = (days || []).findIndex(d => d.id === up.current_day_id);
      if (idx === -1) return res.status(404).json({ error: 'Current day not found' });
      const next = days[idx + 1];
      if (!next) {
        db.run("UPDATE user_programs_v2 SET active = 0, completed = 1 WHERE id = ?", [up.id], (err3) => {
          if (err3) return res.status(500).json({ error: err3.message });
          res.json({ status: 'ok', completed: true });
        });
      } else {
        db.run("UPDATE user_programs_v2 SET current_day_id = ? WHERE id = ?", [next.id, up.id], (err3) => {
          if (err3) return res.status(500).json({ error: err3.message });
          res.json({ status: 'ok', completed: false });
        });
      }
    });
  });
});

app.get('/api/yoga2/programs', (req, res) => {
  const lvl = [1, 2, 3, 4, 5].includes(parseInt(req.query.level)) ? parseInt(req.query.level) : null;
  const focus = String(req.query.focus || '').slice(0, 40);
  let sql = "SELECT id, title, focus, level, minutes, description FROM yoga_programs WHERE 1=1";
  const params = [];
  if (lvl) { sql += " AND level = ?"; params.push(lvl); }
  if (focus) { sql += " AND focus = ?"; params.push(focus); }
  sql += " ORDER BY level, id";
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ programs: rows || [] });
  });
});

app.get('/api/yoga2/program/:id', async (req, res) => {
  db.get("SELECT * FROM yoga_programs WHERE id = ?", [req.params.id], async (err, program) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!program) return res.status(404).json({ error: 'Not found' });
    let poses = [];
    try { poses = JSON.parse(program.poses || '[]'); } catch (e) { poses = []; }
    const enriched = await Promise.all(poses.map(async (p) => {
      const pose = await new Promise((resolve) => db.get("SELECT id, name, how, why FROM yoga_poses WHERE id = ?", [p.pose_id], (e, r) => resolve(r)));
      return { ...pose, seconds: p.seconds, gif_url: await yogaPoseMedia(p.pose_id) };
    }));
    delete program.poses;
    res.json({ program, poses: enriched.filter(p => p && p.id) });
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
  touchSeen(tgId);
  db.run(`INSERT INTO workout_logs (tg_id, program_id, program_day_id, date, duration_minutes, total_volume, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [tgId, program_id || null, program_day_id || null, userDay(req),
     Math.min(Number(duration_minutes) || 0, 600), _totalVolume, String(notes || '').slice(0, 300)],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      const logId = this.lastID;
      const done = () => { bumpAchievements(tgId); res.json({ status: 'ok', log_id: logId, total_volume: _totalVolume }); };
      if (_cleanSets.length > 0) {
        const stmt = db.prepare(`INSERT INTO workout_sets (log_id, exercise_id, set_number, reps, weight)
            VALUES (?, ?, ?, ?, ?)`);
        let setErr = null, pending = _cleanSets.length;
        _cleanSets.forEach(s3 => stmt.run(logId, s3.exercise_id, s3.set_number, s3.reps, s3.weight, (e) => {
          if (e && !setErr) setErr = e;
          if (--pending === 0) stmt.finalize(() => {
            if (setErr) return res.status(500).json({ error: setErr.message });
            done();
          });
        }));
      } else done();
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
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  db.get("SELECT * FROM workout_logs WHERE id = ? AND tg_id = ?", [req.params.id, tgId], (err, log) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!log) return res.status(404).json({ error: 'Not found' });
    db.all(`SELECT ws.*, e.name as exercise_name
        FROM workout_sets ws LEFT JOIN exercises e ON ws.exercise_id = e.id
        WHERE ws.log_id = ?`, [req.params.id], (err, sets) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ log, sets: sets || [] });
    });
  });
});

/* ================= вода и вес ================= */
app.post('/api/water/undo', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  const today = userDay(req);
  const STEP = 250; // один стакан
  // v24: вода хранится ОДНОЙ строкой на день (UNIQUE(tg_id,date), amount_ml копится через UPDATE +250).
  // Прежний DELETE сносил строку целиком — «−» убирал сразу всю воду за день. Теперь снимаем ровно один стакан, ниже нуля не идём.
  db.get("SELECT amount_ml FROM water_logs WHERE tg_id = ? AND date = ?", [tgId, today], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    const cur = row ? (Number(row.amount_ml) || 0) : 0;
    if (cur <= 0) return res.json({ status: 'ok', removed: 0, total: 0 });
    const next = Math.max(cur - STEP, 0);
    db.run("UPDATE water_logs SET amount_ml = ? WHERE tg_id = ? AND date = ?", [next, tgId, today], (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ status: 'ok', removed: 1, total: next });
    });
  });
});

// Напоминания формируются на устройстве, но флаг храним на сервере: он виден в выгрузке
// данных и админке. Тело может задать состояние явно ({enabled:true|false});
// без тела поведение прежнее — переключение.
app.post('/api/notifications/toggle', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  const explicit = typeof req.body?.enabled === 'boolean' ? req.body.enabled : null;
  const sql = explicit === null
    ? "UPDATE users SET notify_enabled = CASE WHEN notify_enabled THEN 0 ELSE 1 END WHERE tg_id = ?"
    : "UPDATE users SET notify_enabled = ? WHERE tg_id = ?";
  const args = explicit === null ? [tgId] : [explicit ? 1 : 0, tgId];
  db.run(sql, args, function (err) {
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
  touchSeen(tgId);
  const today = userDay(req);
  const respondWithTotal = () => {
    db.get("SELECT amount_ml FROM water_logs WHERE tg_id = ? AND date = ?", [tgId, today], (e, r) => {
      bumpAchievements(tgId);
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
  db.get("SELECT amount_ml FROM water_logs WHERE tg_id = ? AND date = ?", [tgId, userDay(req)], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ amount: row ? row.amount_ml : 0 });
  });
});

app.post('/api/weight', (req, res) => {
  const tgId = resolveTgId(req);
  if (!tgId) return res.status(401).json({ error: 'Unauthorized' });
  const { weight } = req.body;
  if (!weight || !(weight >= 20) || weight > 400) return res.status(400).json({ error: 'Invalid weight' });
  touchSeen(tgId);
  /* v29.1: одна запись на день (уникальный индекс) — повторное взвешивание перезаписывает,
     история прошлых дней сохраняется; INSERT OR REPLACE теперь работает корректно */
  db.run("INSERT INTO weight_logs (tg_id, date, weight) VALUES (?, ?, ?) " +
    "ON CONFLICT(tg_id, date) DO UPDATE SET weight = excluded.weight",
    [tgId, userDay(req), weight], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      db.get("SELECT gender, height, age, activity_level, goal FROM users WHERE tg_id = ?", [tgId], (e2, u) => {
        bumpAchievements(tgId);
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
  // v29: разблокировка достижений сразу после значимых событий (тренировка/вес/вода/дневник),
  // а не только при заходе в профиль — баг «засчитывается только после входа во вкладку профиль».
  // Раньше здесь стояли И checkAchievements, И bumpAchievements — это одна и та же функция,
  // поэтому весь пересчёт (6 запросов к БД) выполнялся дважды на каждый заход в профиль.
  bumpAchievements(tgId);
  db.all("SELECT * FROM achievements", [], (err, allAch) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all("SELECT achievement_id FROM user_achievements WHERE tg_id = ?", [tgId], (err, userAch) => {
      if (err) return res.status(500).json({ error: err.message });
      const unlocked = new Set((userAch || []).map(a => a.achievement_id));
      res.json({ achievements: allAch.map(a => ({ ...a, unlocked: unlocked.has(a.id) })) });
    });
  });
});

/* ================= напоминания =================
   Раньше их рассылал сервер через Telegram-бот (крон раз в 30 минут). Telegram удалён,
   поэтому напоминания стали ЛОКАЛЬНЫМИ: приложение планирует системные уведомления
   Android (AlarmManager → ReminderReceiver) по выбранному пользователем часовому поясу.
   Сервер для этого не нужен и данные о напоминаниях никуда не передаются. */

// Чистка: истёкшие сессии (TTL 180 дней)
function pruneOld() {
  const cutoff = sessionCutoff();
  db.run("DELETE FROM sessions WHERE created_at < ?", [cutoff], (e) => {
    if (e) console.error('sessions prune:', e.message);
  });
}
setInterval(pruneOld, 6 * 60 * 60 * 1000);
setTimeout(pruneOld, 60 * 1000);

/* Обработчик ошибок Express: сюда попадают синхронные броски обработчиков и ошибки
   разбора тела от body-parser. У последних уже есть свой статус (битый JSON,
   примитив вместо объекта при strict-разборе, тело больше лимита) — раньше на всё это
   отдавалось 500 «Internal error», и клиент считал, что сломался сервер, хотя
   виноват запрос. 4xx отдаём как есть, 5xx логируем со стеком. */
app.use((err, req, res, next) => {
  const status = Number(err && (err.status || err.statusCode)) || 500;
  if (status >= 500) {
    console.error('Unhandled error ' + req.method + ' ' + req.originalUrl + ':', err);
    return res.status(status).json({ error: 'Internal error' });
  }
  console.warn('Отклонён запрос ' + req.method + ' ' + req.originalUrl + ' (' + status + '): ' + (err.message || ''));
  res.status(status).json({ error: 'Invalid request' });
});

// --- Фото упражнений/рецептов через Pexels (ключ в .env: PEXELS_API_KEY) ---
// v28: кеш на диске (static/images/cache, webp через sharp). Pexels API дёргается
// только ОДИН раз на конкретный запрос фото; повторные отдаём локально.
let sharpLib = null;
try { sharpLib = require('sharp'); } catch (e) { sharpLib = null; }
const IMG_DIR = path.join(__dirname, 'static', 'images', 'cache');async function cacheImageLocally(remoteUrl, slugBase) {
  try{
    // Скачивать имеет смысл только удалённый файл: относительный путь — это уже наш
    // локальный файл, и fetch("/images/...") в Node падает с "Failed to parse URL".
    if (!/^https?:\/\//i.test(String(remoteUrl || ''))) return null;
    const slug = crypto.createHash('md5').update(String(slugBase || remoteUrl)).digest('hex').slice(0, 16) + '.webp';
    const localPath = path.join(IMG_DIR, slug);
    const localUrl = '/images/cache/' + slug;
    if (fs.existsSync(localPath)) return localUrl;
    const imgRes = await fetch(remoteUrl, { signal: AbortSignal.timeout(10000) });
    if (!imgRes.ok) return null;
    const buf = Buffer.from(await imgRes.arrayBuffer());
    let out = buf;
    if (sharpLib) out = await sharpLib(buf).resize(640, 480, { fit: 'inside' }).webp({ quality: 78 }).toBuffer();
    fs.mkdirSync(IMG_DIR, { recursive: true });
    fs.writeFileSync(localPath, out);
    return localUrl;
  } catch (e) { console.error('img cache:', e.message); return null; }
}

app.get('/api/recipe-image/:id', async (req, res) => {
  db.get("SELECT title, image_url, photo_query FROM recipes WHERE id = ?", [req.params.id], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Not found' });
    const hasReal = row.image_url && row.image_url.length > 3 && row.image_url !== 'empty.jpg';
    if (hasReal) {
      // Любой относительный путь — уже локальный файл на нашем сервере: и кеш Pexels
      // (/images/cache/...), и блюда генератора (/images/dishes/...).
      // Раньше проверялся только /images/cache/, поэтому блюда из /images/dishes/
      // уходили в cacheImageLocally и падали в fetch("/images/...")
      // с "Failed to parse URL from /images/..." — по ошибке на каждую картинку.
      if (/^\//.test(String(row.image_url))) return res.json({ image_url: row.image_url, cached: true });
      // удалённый URL (Pexels) — переносим в локальный кеш, чтобы не тянуть повторно
      const local = await cacheImageLocally(row.image_url, row.photo_query || row.title || row.image_url);
      if (local) {
        db.run("UPDATE recipes SET image_url = ? WHERE id = ?", [local, req.params.id], () => {});
        return res.json({ image_url: local, cached: true });
      }
      return res.json({ image_url: row.image_url, cached: true });
    }
    const url = await fetchPexelsPhoto(row.photo_query || (row.title + ' food dish'));
    if (url) {
      const local = await cacheImageLocally(url, row.photo_query || row.title || url);
      const finalUrl = local || url;
      db.run("UPDATE recipes SET image_url = ? WHERE id = ?", [finalUrl, req.params.id],
        (err2) => { if (err2) console.error('cache err:', err2.message); });
      return res.json({ image_url: finalUrl, cached: !!local });
    }
    res.json({ image_url: '', cached: false });
  });
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
