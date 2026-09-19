/* Целостность JSON-каталогов. Регрессы, которые эти тесты ловят:
   - дубли id в exercises.json (INSERT по PRIMARY KEY падал/перезаписывал);
   - dangling-ссылки: programs.json или seed-fit-v2.js указывают на упражнение,
     которого нет в exercises.json — сервер молча выкидывал его из списка JOIN-ом;
   - yoga.json ссылается на несуществующую позу. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

const exercises = readJson('exercises.json');
const exerciseIds = new Set(exercises.map(e => e.id));

test('exercises.json: id уникальны', () => {
  const seen = new Set(), dup = [];
  for (const e of exercises) {
    if (seen.has(e.id)) dup.push(e.id);
    seen.add(e.id);
  }
  assert.deepStrictEqual(dup, [], 'дубли id: ' + dup.join(', '));
});

test('programs.json: все references указывают на существующие упражнения', () => {
  const programs = readJson('programs.json');
  const missing = new Set();
  for (const p of programs) {
    for (const d of (p.days || [])) {
      for (const ex of (d.exercises || [])) {
        if (!exerciseIds.has(ex.exercise_id)) missing.add(ex.exercise_id);
      }
    }
  }
  assert.deepStrictEqual([...missing], [], 'нет упражнений с id: ' + [...missing].join(', '));
});

test('yoga.json: потоки ссылаются на существующие позы', () => {
  const yoga = readJson('yoga.json');
  const poseIds = new Set((yoga.poses || []).map(p => p.id));
  const missing = new Set();
  for (const f of (yoga.flows || [])) {
    for (const p of (f.poses || [])) {
      if (!poseIds.has(p.pose_id)) missing.add(p.pose_id);
    }
  }
  assert.deepStrictEqual([...missing], [], 'нет поз с id: ' + [...missing].join(', '));
});

test('seed-fit-v2.js: карта EX не ссылается на отсутствующие упражнения', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'seed-fit-v2.js'), 'utf8');
  const block = src.match(/const EX = \{([\s\S]*?)\};/);
  assert.ok(block, 'в seed-fit-v2.js не найдена карта EX');
  const ids = [...block[1].matchAll(/\w+:\s*(\d+)/g)].map(m => Number(m[1]));
  const missing = [...new Set(ids)].filter(id => !exerciseIds.has(id));
  assert.deepStrictEqual(missing, [], 'нет упражнений с id: ' + missing.join(', '));
});
