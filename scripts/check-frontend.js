#!/usr/bin/env node
/* Проверка static/index.html: каждый <script>-блок должен компилироваться.
   Регулярка сознательно режет по первому '</script>' — так же делает HTML-парсер,
   поэтому ловит случаи '</script>' и кавычек внутри JS-строк (белый экран в проде).
   Запуск: node scripts/check-frontend.js (входит в npm run check). */
const fs = require('fs');
const vm = require('vm');

const path = require('path').join(__dirname, '..', 'static', 'index.html');
const html = fs.readFileSync(path, 'utf8');

const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
let m, i = 0, fail = 0, checked = 0;
while ((m = re.exec(html))) {
  const src = m[1];
  if (!src.trim()) continue;
  i++; checked++;
  try {
    new vm.Script(src, { filename: 'index.html#block' + i });
  } catch (e) {
    fail++;
    console.error('✗ script-блок #' + i + ': ' + e.message);
    const line = String(e.stack).match(/block\d+:(\d+)/);
    if (line) {
      const ln = parseInt(line[1], 10);
      const lines = src.split('\n');
      for (let j = Math.max(0, ln - 3); j < Math.min(lines.length, ln + 2); j++) {
        console.error('   ' + (j + 1 === ln ? '>>' : '  ') + (j + 1) + ': ' + lines[j].slice(0, 140));
      }
    }
  }
}
// базовая HTML-санитария: парность ключевых тегов
[['<div', '</div'], ['<script', '</script']].forEach(([o, c]) => {
  const open = (html.match(new RegExp(o + '[\\s>]', 'gi')) || []).length;
  const close = (html.split(c).length - 1);
  if (o === '<div' && Math.abs(open - close) > 2) { console.error('✗ подозрение на незакрытые <div>: open=' + open + ' close=' + close); fail++; }
});
if (fail) { console.error('FRONTEND CHECK FAILED'); process.exit(1); }
console.log('✓ frontend: ' + checked + ' script-блоков скомпилированы без ошибок');
