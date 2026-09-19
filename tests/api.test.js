/* Smoke-тесты GuideFit API.
   Запуск: npm test  (node --test tests/)
   Тесты поднимают настоящий server.js на случайном порту и ОТДЕЛЬНОЙ временной
   базе (DB_PATH), поэтому продакшн-данные не затрагиваются. Telegram из продукта
   удалён (v32): единственный вход — сессия устройства (анонимный аккаунт или VK ID).

   Что покрыто: health, заголовки безопасности, отказ без авторизации,
   анонимная регистрация, визард (валидация возраста), вода и её отмена,
   дневник питания (проверка каталога), экспорт данных (152-ФЗ),
   отсутствие удалённых Telegram-эндпоинтов, тумблер уведомлений, удаление аккаунта
   вместе с сессией и лимит на анонимные аккаунты. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 4710 + Math.floor(Math.random() * 200);
const BASE = 'http://127.0.0.1:' + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-test-'));
const DB = path.join(TMP, 'test.db');
let child = null;

async function api(url, { method = 'GET', body, token, admin } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['x-session-token'] = token;
  if (admin) headers['x-admin-token'] = 'test-admin-token';
  const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch (e) {}
  return { status: res.status, body: json, headers: res.headers };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Прямое чтение тестовой базы — для проверок, которых не видно через API
// (например, что удаление аккаунта подчистило свои служебные строки).
function dbGet(sql, args = []) {
  const sqlite3 = require('sqlite3');
  return new Promise((resolve, reject) => {
    const d = new sqlite3.Database(DB, sqlite3.OPEN_READONLY);
    d.get(sql, args, (e, row) => { d.close(); e ? reject(e) : resolve(row); });
  });
}

async function waitFor(pred, timeoutMs = 30000, stepMs = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await pred()) return true; } catch (e) {}
    await sleep(stepMs);
  }
  return false;
}

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: DB,
      TZ: 'Europe/Moscow',
      ADMIN_TOKEN: 'test-admin-token',
      MINIAPP_URL: 'https://example.test/'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', d => process.stdout.write('[server] ' + d));
  child.stderr.on('data', d => process.stderr.write('[server] ' + d));
  const up = await waitFor(async () => (await api('/api/health')).status === 200, 40000);
  assert.ok(up, 'сервер не поднялся на порту ' + PORT);
  // v30: каталог рецептов больше не сеется из recipes.json — импортируем Unitools в тестовую базу
  await new Promise((resolve, reject) => {
    const imp = spawn(process.execPath, ['scripts/import-unitools.js'], {
      cwd: ROOT,
      env: { ...process.env, DB_PATH: DB },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let err = '';
    imp.stderr.on('data', d => { err += d; });
    imp.on('exit', code => code === 0 ? resolve() : reject(new Error('импорт каталога упал: ' + err)));
  });
});

after(async () => {
  if (child && child.exitCode === null) { child.kill('SIGKILL'); await sleep(200); }
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + s); } catch (e) {} }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

/* ---------- 1. Служебное ---------- */
test('health: база доступна и версия отдаётся', async () => {
  const r = await api('/api/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.status, 'ok');
  assert.strictEqual(r.body.db, 'ok');
  assert.match(String(r.body.version), /^\d+\.\d+\.\d+$/);
});

test('заголовки безопасности установлены, Telegram-источников в CSP нет', async () => {
  const r = await api('/api/health');
  const csp = r.headers.get('content-security-policy') || '';
  assert.ok(csp.includes("frame-ancestors 'self'"), 'страницу можно встроить только в свой же домен');
  assert.ok(!csp.includes('telegram'), 'после удаления Telegram его источников в CSP быть не должно');
  assert.ok(csp.includes("object-src 'none'"), 'CSP object-src none');
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(!r.headers.get('x-frame-options'), 'X-Frame-Options не используется (управляем через CSP)');
  assert.ok((r.headers.get('strict-transport-security') || '').includes('max-age='), 'HSTS');
});

test('без сессии приватные данные недоступны', async () => {
  assert.strictEqual((await api('/api/user/export')).status, 401);
  assert.strictEqual((await api('/api/user/anon:deadbeef')).status, 401);
  assert.strictEqual((await api('/api/user/1')).status, 401);
  assert.strictEqual((await api('/api/auth/me')).status, 401);
});

/* ---------- 2. Анонимная регистрация и визард ---------- */
let TOKEN = null;
let TG_ID = null;

test('анонимная регистрация выдаёт сессию и создаёт пустой профиль', async () => {
  const r = await api('/api/auth/anonymous', { method: 'POST' });
  assert.strictEqual(r.status, 200);
  assert.match(String(r.body.session), /^[0-9a-f]{64}$/);
  TOKEN = r.body.session;

  const me = await api('/api/auth/me', { token: TOKEN });
  assert.strictEqual(me.status, 200);
  assert.match(me.body.tg_id, /^anon:[0-9a-f]{18}$/);
  TG_ID = me.body.tg_id;

  const user = await api('/api/user/' + TG_ID, { token: TOKEN });
  assert.strictEqual(user.status, 200);
  assert.strictEqual(user.body.goal, null, 'до визарда цель пустая');
  assert.strictEqual(user.body.name, null, 'имя не предзаполняется');
  assert.strictEqual(user.body.provider, 'anon');
});

test('визард: валидация полей и возраст не младше 12', async () => {
  const base = { name: 'Тест', goal: 'lose', gender: 'male', age: 30, height: 180, current_weight: 80,
                 target_weight: 75, activity_level: 'moderate', meal_count: 3,
                 consents: { privacy: true, terms: true, health: true } };

  const missing = await api('/api/user/init', { method: 'POST', token: TOKEN, body: { name: 'Только имя' } });
  assert.strictEqual(missing.status, 400, 'неполные данные отвергаются');

  // 152-ФЗ: без согласий обработка не начинается — создаём отдельный аккаунт, чтобы не портить TOKEN
  const noConsent = await api('/api/auth/anonymous', { method: 'POST' });
  assert.strictEqual(noConsent.status, 200);
  const noConsentInit = await api('/api/user/init', { method: 'POST', token: noConsent.body.session, body: { ...base, consents: undefined } });
  assert.strictEqual(noConsentInit.status, 403, 'без согласий профиль не создаётся');
  const noHealth = await api('/api/user/init', { method: 'POST', token: noConsent.body.session, body: { ...base, consents: { privacy: true, terms: true, health: false } } });
  assert.strictEqual(noHealth.status, 403, 'без отдельного согласия ст. 10 профиль не создаётся');

  const young = await api('/api/user/init', { method: 'POST', token: TOKEN, body: { ...base, age: 11 } });
  assert.strictEqual(young.status, 400, 'возраст < 12 отвергается');

  const noAge = await api('/api/user/init', { method: 'POST', token: TOKEN, body: { ...base, age: undefined } });
  assert.strictEqual(noAge.status, 400, 'без возраста профиль не создаётся');

  const badGoal = await api('/api/user/init', { method: 'POST', token: TOKEN, body: { ...base, age: 30, goal: 'hack' } });
  assert.strictEqual(badGoal.status, 400, 'некорректная цель отвергается');

  const ok = await api('/api/user/init', { method: 'POST', token: TOKEN, body: { ...base, age: 30 } });
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.body.calorie_norm > 1000, 'норма калорий рассчитана');

  const user = await api('/api/user/' + TG_ID, { token: TOKEN });
  assert.strictEqual(user.body.age, 30);
  assert.strictEqual(user.body.name, 'Тест');
  assert.strictEqual(user.body.meal_count, 3, 'meal_count из визарда сохраняется (регресс: на главной показывался дефолт 4)');

  // журнал согласий: согласие зафиксировано сервером (доказуемость, 152-ФЗ ст. 9/10)
  const consentRow = await dbGet('SELECT privacy, terms, health, doc_version FROM consent_log WHERE tg_id = ?', [TG_ID]);
  assert.ok(consentRow, 'согласие записано в журнал');
  assert.strictEqual(consentRow.privacy, 1);
  assert.strictEqual(consentRow.terms, 1);
  assert.strictEqual(consentRow.health, 1, 'отдельное согласие на данные о здоровье (ст. 10) зафиксировано');
  assert.ok(String(consentRow.doc_version).length >= 8, 'версия документов зафиксирована');

  const tooOld = await api('/api/user/update', { method: 'POST', token: TOKEN, body: { age: 101 } });
  assert.strictEqual(tooOld.status, 400, 'невозможный возраст отвергается при обновлении');
});

/* ---------- 2б. Новая регистрация уведомляет админа ----------
   Регресс: в /api/user/init стоял db.get("SELECT changes FROM users …") — такой колонки
   в SQLite нет, запрос всегда падал с SQLITE_ERROR, и админ НИКОГДА не получал
   уведомление о регистрации (в чат поддержки строка тоже не попадала). */
test('визард пишет уведомление о новой регистрации в чат поддержки (один раз)', async () => {
  const reg = await api('/api/auth/anonymous', { method: 'POST' });
  assert.strictEqual(reg.status, 200);
  const tok = reg.body.session;
  const me = await api('/api/auth/me', { token: tok });
  const anonId = me.body.tg_id;
  const body = {
    name: 'Новичок', goal: 'gain', gender: 'male', age: 25, height: 175, current_weight: 70,
    target_weight: 75, activity_level: 'light', meal_count: 3,
    consents: { privacy: true, terms: true, health: true } };

  assert.strictEqual((await api('/api/user/init', { method: 'POST', token: tok, body })).status, 200);

  const th = await api('/api/admin/support/threads', { admin: true });
  assert.strictEqual(th.status, 200);
  const row = (th.body.threads || []).find(t => t.tg_id === anonId);
  assert.ok(row, 'новая регистрация видна в админке (support_messages)');
  assert.ok(String(row.last_text || '').indexOf('Новая регистрация') !== -1, 'текст — уведомление о регистрации');

  // повторное сохранение заполненного профиля не должно дублировать уведомление
  assert.strictEqual((await api('/api/user/init', { method: 'POST', token: tok, body })).status, 200);
  const thread = await api('/api/admin/support/thread/' + encodeURIComponent(anonId), { admin: true });
  assert.strictEqual(thread.body.messages.length, 1, 'уведомление приходит один раз, а не при каждом сохранении');
});

/* ---------- 2в. Согласие на актуальную редакцию документов (152-ФЗ, ст. 9) ---------- */
test('согласие: сервер знает редакцию пользователя и принимает повторное', async () => {
  // версия документов отдаётся вместе с версией приложения — клиент по ней решает,
  // нужно ли просить согласие заново
  const v = await api('/api/app-version');
  assert.strictEqual(v.status, 200);
  assert.match(String(v.body.docs), /^\d{4}-\d{2}-\d{2}$/, 'редакция документов в формате ГГГГ-ММ-ДД');

  const c = await api('/api/user/consent', { token: TOKEN });
  assert.strictEqual(c.status, 200);
  assert.strictEqual(c.body.current, v.body.docs, 'текущая редакция одна и та же');
  assert.strictEqual(c.body.accepted, v.body.docs, 'после визарда согласие уже покрывает текущую редакцию');

  // частичное согласие не принимаем
  const partial = await api('/api/user/consent', { method: 'POST', token: TOKEN, body: { consents: { privacy: true, terms: true, health: false } } });
  assert.strictEqual(partial.status, 403, 'без отдельного согласия ст. 10 повторное подтверждение не проходит');
  assert.strictEqual((await api('/api/user/consent', { method: 'POST', token: TOKEN, body: {} })).status, 403);
  assert.strictEqual((await api('/api/user/consent', { method: 'POST', body: { consents: { privacy: true, terms: true, health: true } } })).status, 401, 'без сессии нельзя');

  const before = await dbGet('SELECT COUNT(*) c FROM consent_log WHERE tg_id = ?', [TG_ID]);
  const ok = await api('/api/user/consent', { method: 'POST', token: TOKEN, body: { consents: { privacy: true, terms: true, health: true } } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.doc_version, v.body.docs);
  const after = await dbGet('SELECT COUNT(*) c FROM consent_log WHERE tg_id = ?', [TG_ID]);
  assert.strictEqual(after.c, before.c + 1, 'подтверждение новой редакции пишется в журнал согласий');
});

/* ---------- 3. Вода ---------- */
test('вода: добавление, границы и отмена по одному стакану', async () => {
  assert.strictEqual((await api('/api/water', { method: 'POST', token: TOKEN, body: { amount: 0 } })).status, 400);
  assert.strictEqual((await api('/api/water', { method: 'POST', token: TOKEN, body: { amount: 99999 } })).status, 400);
  assert.strictEqual((await api('/api/water', { method: 'POST', body: { amount: 250 } })).status, 401, 'без сессии нельзя');

  const a1 = await api('/api/water', { method: 'POST', token: TOKEN, body: { amount: 250 } });
  assert.strictEqual(a1.status, 200);
  assert.strictEqual(a1.body.total, 250);
  const a2 = await api('/api/water', { method: 'POST', token: TOKEN, body: { amount: 250 } });
  assert.strictEqual(a2.body.total, 500);

  const und = await api('/api/water/undo', { method: 'POST', token: TOKEN, body: {} });
  assert.strictEqual(und.status, 200);
  assert.ok(und.body.removed, 'стакан снят');
  assert.strictEqual(und.body.total, 250);
  assert.strictEqual((await api('/api/water/' + TG_ID, { token: TOKEN })).body.amount, 250);

  const und2 = await api('/api/water/undo', { method: 'POST', token: TOKEN, body: {} });
  assert.ok(und2.body.removed);
  const und3 = await api('/api/water/undo', { method: 'POST', token: TOKEN, body: {} });
  assert.strictEqual(und3.body.removed, 0, 'ниже нуля не уходим');
  assert.strictEqual(und3.body.total, 0);
});

/* ---------- 4. Дневник питания ---------- */
test('дневник питания: мусорный рецепт не пишется в лог', async () => {
  assert.strictEqual((await api('/api/log-meal', { method: 'POST', token: TOKEN, body: { recipe_id: 'abc' } })).status, 400);
  assert.strictEqual((await api('/api/log-meal', { method: 'POST', token: TOKEN, body: { recipe_id: 999999 } })).status, 404);

  const seeded = await waitFor(async () => (await api('/api/recipe/20000')).status === 200, 40000);
  assert.ok(seeded, 'каталог рецептов загрузился');
  const good = await api('/api/log-meal', { method: 'POST', token: TOKEN, body: { recipe_id: 20000 } });
  assert.strictEqual(good.status, 200);

  const today = await api('/api/food-log/today/' + TG_ID, { token: TOKEN });
  assert.strictEqual(today.status, 200);
  assert.ok(Array.isArray(today.body.meals) && today.body.meals.length >= 1, 'запись видна в дневнике');
  assert.ok(today.body.meals[0].title, 'в дневнике блюдо из каталога, а не пустая строка');
});

/* ---------- 5. Экспорт данных ---------- */
test('экспорт данных: профиль, вода, питание и тренировки в одном файле', async () => {
  const w = await api('/api/weight', { method: 'POST', token: TOKEN, body: { weight: 79.5 } });
  assert.strictEqual(w.status, 200);

  const r = await api('/api/user/export', { token: TOKEN });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.service, 'GuideFit');
  assert.strictEqual(r.body.profile.id, TG_ID);
  assert.strictEqual(r.body.profile.age, 30);
  assert.ok(Array.isArray(r.body.water) && r.body.water.length >= 1);
  assert.ok(Array.isArray(r.body.meals) && r.body.meals.length >= 1);
  assert.ok(Array.isArray(r.body.weights) && r.body.weights.length >= 1);
  assert.ok(!('notify_chat_id' in r.body.profile), 'служебный chat_id не отдаём');
});

/* ---------- 6. Уведомления: Telegram-эндпоинтов больше нет ---------- */
test('Telegram удалён: эндпоинты привязки чата не существуют', async () => {
  assert.strictEqual((await api('/api/user/link/telegram', { method: 'POST', token: TOKEN, body: {} })).status, 404);
  assert.strictEqual((await api('/api/user/link/telegram/remove', { method: 'POST', token: TOKEN, body: {} })).status, 404);
});

test('флаг напоминаний: явное значение и прежнее переключение', async () => {
  // напоминания локальные, но флаг хранится на сервере — приложение шлёт явное значение
  const explicitOff = await api('/api/notifications/toggle', { method: 'POST', token: TOKEN, body: { enabled: false } });
  assert.strictEqual(explicitOff.status, 200);
  assert.strictEqual(explicitOff.body.notify_enabled, 0);
  const explicitOn = await api('/api/notifications/toggle', { method: 'POST', token: TOKEN, body: { enabled: true } });
  assert.strictEqual(explicitOn.body.notify_enabled, 1);

  const users = await api('/api/admin/users', { admin: true });
  assert.strictEqual(users.status, 200, 'админка отвечает при верном токене');
  assert.strictEqual((await api('/api/admin/users')).status, 403, 'без токена админка закрыта');

  // без тела — прежнее поведение (переключение), меню настроек его больше не использует
  const flipped = await api('/api/notifications/toggle', { method: 'POST', token: TOKEN, body: {} });
  assert.strictEqual(flipped.status, 200);
  assert.strictEqual(flipped.body.notify_enabled, 0);
});

/* ---------- 7. Удаление аккаунта ---------- */
test('удаление аккаунта закрывает и его сессии', async () => {
  const del = await api('/api/user/delete', { method: 'POST', token: TOKEN, body: {} });
  assert.strictEqual(del.status, 200);
  assert.strictEqual((await api('/api/user/' + TG_ID, { token: TOKEN })).status, 401, 'старый токен больше не работает');
  const left = await dbGet('SELECT COUNT(*) c FROM consent_log WHERE tg_id = ?', [TG_ID]);
  assert.strictEqual(left.c, 0, 'журнал согласий удалён вместе с аккаунтом (152-ФЗ, ст. 21)');
});

/* ---------- 7b. Подбор блюда под норму пользователя (v30) ---------- */
test('подбор блюда: диапазон калорий считается из профиля, цель сужает его', async () => {
  const reg = await api('/api/auth/anonymous', { method: 'POST' });
  assert.strictEqual(reg.status, 200);
  const tok = reg.body.session;
  const init = await api('/api/user/init', { method: 'POST', token: tok, body: {
    name: 'Диета', goal: 'lose', gender: 'female', age: 28, height: 165, current_weight: 60,
    target_weight: 55, activity_level: 'light', meal_count: 4,
    consents: { privacy: true, terms: true, health: true } } });
  assert.strictEqual(init.status, 200);
  assert.ok(init.body.calorie_norm > 1000, 'норма рассчитана');

  const r = await api('/api/meal', { method: 'POST', token: tok, body: { category: 'breakfast' } });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.recipe && r.body.recipe.title, 'блюдо подобрано');
  assert.strictEqual(r.body.recipe.category, 'breakfast');
  // норма*25% (4 приёма = база; доли согласованы с генератором каталога) ±20%, при «похудении» верх срезается до целевого значения
  const t = Math.round(init.body.calorie_norm * 0.25);
  assert.deepStrictEqual(r.body.meal_range, [Math.round(t * 0.8), t]);
  assert.ok(r.body.recipe.calories <= Math.round(t * 1.15 * 1.15), 'даже с fallback блюдо недалеко от диапазона');

  // чужие категории отвергаются (фиксированный набор из 4)
  assert.strictEqual((await api('/api/meal', { method: 'POST', token: tok, body: { category: 'полдник' } })).status, 400);
  assert.strictEqual((await api('/api/meal', { method: 'POST', token: tok, body: {} })).status, 400);
});

/* ---------- 8. Лимит на анонимные аккаунты (последним: квота исчерпывается) ---------- */
test('лимит анонимных аккаунтов: после 10 в час приходит 429', async () => {
  const codes = [];
  for (let i = 0; i < 15; i++) codes.push((await api('/api/auth/anonymous', { method: 'POST' })).status);
  assert.ok(codes.includes(200), 'часть запросов проходит');
  assert.ok(codes.includes(429), 'после лимита приходит 429');
});
