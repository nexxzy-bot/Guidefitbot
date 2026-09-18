/* Тест генератора scripts/gen-pp-dishes.js без реального Gemini:
   поднимает локальный мок-сервер и прогоняет на ВРЕМЕННОЙ БД (DB_PATH),
   изолированном стейте (GEN_STATE_FILE) и переопределённом endpoint (GEMINI_URL).

   Сценарии:
   1) 429 -> --nowait: процесс выходит с кодом 2, не падая и не записывая в БД;
   2) успех -> --limit-batches 1: ровно один батч из 10 блюд попадает в
      dishes/ingredients/dish_ingredients/dish_steps + legacy recipes, стейт сохранён;
   3) возобновление: второй запуск без стейта не делает HARD RESET (блюда не задвоены);
   4) валидация: экзотика/латиница/битые КБЖУ отбраковываются. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-gen-'));
const DB = path.join(TMP, 'gen.db');
const STATE = path.join(TMP, 'gen-state.json');

const dish = (name, kcal, p, f, c) => ({
  name, minutes: 12,
  ingredients: [
    { name: 'Куриное филе', amount: 200, unit: 'г' },
    { name: 'Гречка', amount: 80, unit: 'г' },
    { name: 'Сметана 10%', amount: 30, unit: 'г' }
  ],
  calories: kcal, protein: p, fat: f, carbs: c,
  steps: ['Обжарить курицу', 'Отварить крупу', 'Соединить и подать']
});

const GOOD_BATCH = [
  dish('Курица с гречкой и сметанным соусом', 500, 38, 14, 52),
  dish('Индейка тушёная с рисом', 480, 36, 12, 55),
  dish('Тефтели в томатном соусе с пюре', 520, 30, 18, 58),
  dish('Минтай запечённый с картофелем', 420, 32, 12, 45),
  dish('Говядина с булгуром и овощами', 540, 35, 16, 60),
  dish('Куриные котлеты с гречкой', 460, 34, 14, 48),
  dish('Свинина тушёная с капустой', 510, 32, 20, 42),
  dish('Омлет с творогом и зеленью', 380, 28, 18, 12),
  dish('Гречневая запеканка с фаршем', 490, 30, 16, 55),
  dish('Рис с курицей и овощами в горшочке', 505, 33, 13, 58)
];

// путь 429: сервер возвращает Too Many Requests
let mode = '429';
let reqCounter = 0; // уникальные имена на каждый запрос — как у реального Gemini
const srv = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (mode === '429') { res.statusCode = 429; return res.end('{}'); }
  if (mode === 'ok') {
    reqCounter++;
    const batch = GOOD_BATCH.map((d, i) => ({ ...d, name: d.name + ' №' + reqCounter + '.' + (i + 1) }));
    return res.end(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(batch) }] } }]
    }));
  }
  if (mode === 'mixed') {
    reqCounter++;
    // половина блюд валидна (суффикс — цифры, не латиница!), половина — мусор
    const half = GOOD_BATCH.slice(0, 5).map((d, i) => ({ ...d, name: d.name + ' вариант ' + reqCounter + '.' + (i + 1) }));
    const junk = [
      dish('Shitake avocado bowl with quinoa', 400, 30, 10, 40),
      dish('Блюдо с латинскимSalmonPoke словом', 400, 30, 10, 40),
      dish('Битые калории', 999999, 30, 10, 40),
      { ...dish('Без шагов', 400, 30, 10, 40), steps: [] },
      { ...dish('С экзотикой', 400, 30, 10, 40), ingredients: [{ name: 'Авокадо', amount: 1, unit: 'шт' }] }
    ];
    return res.end(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify([...half, ...junk]) }] } }]
    }));
  }
  res.statusCode = 500;
  res.end('{}');
});

let child;
function runScript(extraEnv, expectCode, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['scripts/gen-pp-dishes.js', ...extraArgs], {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    p.stdout.on('data', d => { out += d; process.stdout.write('[gen] ' + d); });
    p.stderr.on('data', d => { out += d; process.stderr.write('[gen!] ' + d); });
    p.on('exit', code => code === expectCode ? resolve(out) : reject(new Error(`код ${code}, ожидался ${expectCode}\n` + out)));
  });
}

function dbAll(sql, args = []) {
  return new Promise((res, rej) => {
    const d = new sqlite3.Database(DB, sqlite3.OPEN_READONLY);
    d.all(sql, args, (e, r) => { d.close(); e ? rej(e) : res(r || []); });
  });
}

before(async () => {
  await new Promise(r => srv.listen(0, r));
  globalThis.mockPort = srv.address().port;
  // готовим пустую тестовую БД со схемой
  await new Promise((resolve, reject) => {
    const imp = spawn(process.execPath, ['scripts/import-unitools.js', '--dry'], {
      cwd: ROOT, env: { ...process.env, DB_PATH: DB }, stdio: ['ignore', 'ignore', 'pipe']
    });
    imp.on('exit', c => c === 0 ? resolve() : reject(new Error('схема не создана')));
  });
});

after(async () => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  srv.close();
  for (const f of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + f); } catch (e) {} }
  try { fs.unlinkSync(STATE); } catch (e) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

test('429 не роняет скрипт: выход с кодом 2 при --nowait, БД не тронута', async () => {
  mode = '429';
  const out = await runScript({
    DB_PATH: DB, GEN_STATE_FILE: STATE,
    GEMINI_URL: `http://127.0.0.1:${globalThis.mockPort}/m1`
  }, 2, ['--nowait']);
  assert.ok(out.includes('429 / квота'), 'квота распознана');
  assert.ok(fs.existsSync(STATE) === false, 'стейт не создан при 429');
  const dishes = await dbAll('SELECT COUNT(*) c FROM dishes');
  assert.strictEqual(dishes[0].c, 0, 'при 429 в БД ничего не пишется');
});

test('батч из 10 блюд пишется в нормализованные таблицы + зеркало, стейт сохраняется', async () => {
  mode = 'ok';
  const out = await runScript({
    DB_PATH: DB, GEN_STATE_FILE: STATE,
    GEMINI_URL: `http://127.0.0.1:${globalThis.mockPort}/m2`
  }, 0, ['--limit-batches', '1']);
  assert.ok(out.includes('Батч принят: +10'), '10 блюд принято');
  const [dishes] = await dbAll('SELECT COUNT(*) c FROM dishes');
  const [links] = await dbAll('SELECT COUNT(*) c FROM dish_ingredients');
  const [steps] = await dbAll('SELECT COUNT(*) c FROM dish_steps');
  const [ings] = await dbAll('SELECT COUNT(*) c FROM ingredients');
  const [mirror] = await dbAll("SELECT COUNT(*) c FROM recipes WHERE id >= 20501");
  const [mirrorJson] = await dbAll("SELECT ingredients j FROM recipes WHERE id >= 20501 LIMIT 1");
  assert.strictEqual(dishes.c, 10);
  assert.strictEqual(links.c, 30); // по 3 ингредиента в блюде
  assert.strictEqual(steps.c, 30); // по 3 шага
  assert.ok(ings.c >= 3);
  assert.strictEqual(mirror.c, 10, 'legacy-зеркало recipes заполнено');
  assert.ok(JSON.parse(mirrorJson.j)[0].name, 'в зеркале ингредиенты с именами');
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  assert.strictEqual(st.batch, 1);
  const sum = Object.values(st.done).reduce((s, c) => s + Object.values(c).reduce((a, b) => a + b, 0), 0);
  assert.strictEqual(sum, 10);
});

test('повторный запуск продолжает, а не сбрасывает (без HARD RESET)', async () => {
  mode = 'ok';
  await runScript({
    DB_PATH: DB, GEN_STATE_FILE: STATE,
    GEMINI_URL: `http://127.0.0.1:${globalThis.mockPort}/m2`
  }, 0, ['--limit-batches', '1']);
  const [dishes] = await dbAll('SELECT COUNT(*) c FROM dishes');
  assert.strictEqual(dishes.c, 20, 'добавилось ещё 10, ничего не задвоено и не очищено');
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  assert.strictEqual(st.batch, 2);
});

test('валидация: экзотика/латиница/битые КБЖУ отбракованы, добирающие раунды набирают полный батч', async () => {
  mode = 'mixed';
  await runScript({
    DB_PATH: DB, GEN_STATE_FILE: STATE,
    GEMINI_URL: `http://127.0.0.1:${globalThis.mockPort}/m3`
  }, 0, ['--limit-batches', '1']);
  const [dishes] = await dbAll('SELECT COUNT(*) c FROM dishes');
  assert.strictEqual(dishes.c, 30, '+10: мусор отбракован, добирающие раунды набрали полный батч');
  const exotic = await dbAll("SELECT id FROM dishes WHERE title LIKE '%Авокадо%' OR title LIKE '%Shitake%'");
  assert.strictEqual(exotic.length, 0, 'экзотика в БД не попала');
});
