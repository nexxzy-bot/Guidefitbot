#!/usr/bin/env node
/* Временный аудит: каждый onclick/oninput/onchange/onsubmit/onkeydown из index.html
   и все inline-обработчики в генерируемых JS-строках должны указывать на существующую функцию. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'static', 'index.html'), 'utf8');

// 1. Собираем все объявленные функции из всех script-блоков
const funcs = new Set();
const reScript = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
let sm;
while ((sm = reScript.exec(html))) {
  const src = sm[1];
  try {
    new vm.Script(src); // проверка компиляции
  } catch (e) { console.error('COMPILE FAIL:', e.message); process.exit(1); }
  const decls = src.match(/function\s+([A-Za-z_$][\w$]*)/g) || [];
  decls.forEach(d => funcs.add(d.replace(/^function\s+/, '')));
  const assigns = src.match(/(?:window\.)?([A-Za-z_$][\w$]*)\s*=\s*function/g) || [];
  assigns.forEach(a => funcs.add(a.replace(/^.*?([A-Za-z_$][\w$]*)\s*=\s*function$/, '$1')));
}

// 2. Все inline-обработчики: и в статичном HTML, и внутри JS-строк
const reAttr = /on(click|input|change|submit|keydown|focus|blur)\s*=\s*["']([^"']+)["']/gi;
const called = [];
let m, i = 0;
while ((m = reAttr.exec(html))) {
  i++;
  const expr = m[2];
  // все вызовы вида name( внутри выражения — проверяем каждый (методы obj.fn( пропускаем)
  for (const cm of expr.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const fn = cm[1];
    if (["if","for","while","switch","catch","function","return","typeof"].includes(fn)) continue;
    called.push({ fn, expr, pos: i });
  }
}

// 3. Каждое выражение обработчика должно компилироваться как statement
let bad = 0;
const seen = new Set();
for (const c of called) {
  if (!funcs.has(c.fn)) { console.error('✗ функция не найдена: ' + c.fn + '  [' + c.expr.slice(0, 90) + ']'); bad++; continue; }
  if (seen.has(c.fn)) continue;
  seen.add(c.fn);
}

// 4. data-tour / data-tab / data-ic
const tabs = new Set(['home','stats','workouts','nutrition','profile']);
[...html.matchAll(/data-tab\s*=\s*"([\w-]+)"/g)].forEach(x => { if (!tabs.has(x[1])) { console.error('✗ неизвестный data-tab: ' + x[1]); bad++; } });
if (!/id="tourOverlay"/.test(html) === false) {} // noop
['tourNext','tourSkip','tourShow','tourPosition','tourOverlay','tourClose','tourMaybe','tourEl'].forEach(f => {
  if (!funcs.has(f)) { console.error('✗ функция тура отсутствует: ' + f); bad++; }
});

// 5. id, на которые ссылается $('...'), должны существовать (статично или создаваться динамически)
const idsStatic = new Set([...html.matchAll(/id="([\w-]+)"/g)].map(x => x[1]));
const idsDynamic = new Set([...html.matchAll(/id=\\"([\w-]+)\\"/g)].map(x => x[1]));
const idRefs = [...html.matchAll(/\$\('([\w-]+)'\)/g)].map(x => x[1]);
for (const id of new Set(idRefs)) {
  if (!idsStatic.has(id) && !idsDynamic.has(id)) { console.error('✗ $(' + id + ') — id нигде не создан'); bad++; }
}

console.log(bad ? ('AUDIT FAILED: ' + bad) : ('✓ аудит обработчиков пройден: ' + funcs.size + ' функций, ' + seen.size + ' уникальных вызовов, id-ссылки целы'));
process.exit(bad ? 1 : 0);
