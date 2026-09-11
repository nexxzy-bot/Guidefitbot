#!/usr/bin/env python3
# GuideFit patch: безопасность сервера + снятие AI-признаков с фронта + 2 бага
import shutil, sys, time, pathlib

ROOT = pathlib.Path('.')
ts = time.strftime('%Y%m%d-%H%M%S')

PATCHES = []

PATCHES.append(('server.js', r'''  const calcHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (calcHash !== hash) return { valid: false };''', r'''  const calcHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const _a = Buffer.from(calcHash, 'hex'), _b = Buffer.from(hash, 'hex');
  if (_a.length !== _b.length || !crypto.timingSafeEqual(_a, _b)) return { valid: false };'''))

PATCHES.append(('server.js', r'''    if (err) return !err;''', r'''    if (err) return;'''))

PATCHES.append(('server.js', r'''  db.get("SELECT amount_ml FROM water_logs WHERE tg_id = ? AND date = ?", [tgId, today], (err, row) => {
    if (row) {
      db.run("UPDATE water_logs SET amount_ml = amount_ml + ? WHERE tg_id = ? AND date = ?",
        [amount, tgId, today], (err2) => {
          if (err2) return res.status(500).json({ error: err2.message });
          checkAchievements(tgId);
          res.json({ status: 'ok', total: row.amount_ml + amount });
        });
    } else {
      db.run("INSERT INTO water_logs (tg_id, date, amount_ml) VALUES (?, ?, ?)", [tgId, today, amount], (err2) => {
        if (err2) return res.status(500).json({ error: err2.message });
        checkAchievements(tgId);
        res.json({ status: 'ok', total: amount });
      });
    }
  });''', r'''  const respondWithTotal = () => {
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
    });'''))

PATCHES.append(('static/index.html', r'''<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">''', r'''<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Chakra+Petch:wght@500;600;700&display=swap" rel="stylesheet">'''))

PATCHES.append(('static/index.html', r'''body{font-family:'Inter',-apple-system,sans-serif;''', r'''body{font-family:'Manrope',-apple-system,sans-serif;'''))

PATCHES.append(('static/index.html', "'Space Grotesk'", "'Chakra Petch'", 'ALL'))

PATCHES.append(('static/index.html', "@media (prefers-color-scheme:light){}\n", ''))

PATCHES.append(('static/index.html', r'''.day-card{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:var(--r);padding:15px;margin-bottom:10px;cursor:pointer}''', r'''.day-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:15px;margin-bottom:10px;cursor:pointer}'''))

ICONS_JS = r'''/* ============ SVG-иконки (вместо эмодзи) ============ */
const ICONS = {
  male:'<circle cx="10" cy="14" r="5"/><path d="M19 5l-5.5 5.5"/><path d="M15 5h4v4"/>',
  female:'<circle cx="12" cy="9" r="5"/><path d="M12 14v7M9 18h6"/>',
  flame:'<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  dumbbell:'<path d="M6.5 6.5v11M17.5 6.5v11M3 9v6M21 9v6M6.5 12h11"/>',
  zap:'<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  chair:'<path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"/><path d="M3 16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1H7v-1a2 2 0 0 0-4 0z"/><path d="M5 18v2M19 18v2"/>',
  walk:'<circle cx="13" cy="4" r="2"/><path d="M13 8l-3 5 2 3v6"/><path d="M10 13l-3 2"/><path d="M13 8l3 2 2 5"/><path d="M11 16l-3 6"/>',
  run:'<circle cx="15" cy="4" r="2"/><path d="M4 20l4-6 4-1-2-5 4-1 3 4 3 1"/><path d="M8 14l-2 7M12 12l3 9"/>',
  home:'<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  trees:'<path d="M12 3 8 9h2.5L7 14h10l-3.5-5H16L12 3z"/><path d="M12 14v7M9 21h6"/>',
  globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 3 2.5 15 0 18"/><path d="M12 3c-2.5 3-2.5 15 0 18"/>',
  heart:'<path d="M12 20.5s-7.5-4.7-9.5-9.5C1 7 3.5 3.5 7 3.5c2.5 0 4 1.7 5 3.5 1-1.8 2.5-3.5 5-3.5 3.5 0 6 3.5 4.5 7.5-2 4.8-9.5 9.5-9.5 9.5z"/>',
  person:'<circle cx="12" cy="5" r="2"/><path d="M5 11l4-2 3 2 4-2 3 3"/><path d="M12 11v5l-2.5 6M12 16l2.5 6"/>',
  sunrise:'<path d="M7 17a5 5 0 0 1 10 0"/><path d="M12 11V4M8.5 6.5 12 3l3.5 3.5M3 21h18M5 17h14"/>',
  utensils:'<path d="M6 3v7a2 2 0 0 0 2 2v9"/><path d="M6 3v4M9 3v4"/><path d="M17 3c-1.7 0-3 1.8-3 4v4h3v10"/>',
  apple:'<path d="M12 8c-2-2.5-5.5-2.5-7.5.5-2 3-1 8.5 2 11.5 1.8 1.5 3.8.8 5.5-.5 1.7 1.3 3.7 2 5.5.5 3-3 4-8.5 2-11.5-2-3-5.5-3-7.5-.5z"/><path d="M12 8c0-2 1-4 3-4.5"/>',
  moon:'<path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z"/>',
  nut:'<circle cx="12" cy="12" r="9"/><path d="M9 9h.01M15 10h.01M10 15h.01M15 15h.01"/>',
  milk:'<path d="M9 2h6M9 2v3l-2 3v11a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V8l-2-3V2"/><path d="M7 13h10"/>',
  droplet:'<path d="M12 2.5s6.5 7 6.5 11.5a6.5 6.5 0 0 1-13 0C5.5 9.5 12 2.5 12 2.5z"/>',
  bowl:'<path d="M4 12h16a8 8 0 0 1-16 0z"/><path d="M9 12V8M12 12V6M15 12V8"/>',
  cart:'<circle cx="9" cy="20" r="1.6"/><circle cx="17" cy="20" r="1.6"/><path d="M2.5 4h2.5l2.5 11h10l2.5-7H6"/>',
  refresh:'<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  chef:'<path d="M7 21h10M7 17v-2a4 4 0 0 1-1-7.87A5 5 0 0 1 12 3a5 5 0 0 1 6 5.13A4 4 0 0 1 17 15v2H7z"/>',
  pen:'<path d="M17 3l4 4L8 20l-5 1 1-5L17 3z"/>',
  sparkles:'<path d="M12 4l1.7 4.3L18 10l-4.3 1.7L12 16l-1.7-4.3L6 10l4.3-1.7L12 4z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z"/>'
};
function ic(name, size){
  size = size || 20;
  return '<svg width="'+size+'" height="'+size+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">'+ICONS[name]+'</svg>';
}
function showToast(msg, type){'''

PATCHES.append(('static/index.html', 'function showToast(msg, type){', ICONS_JS))

PATCHES.append(('static/index.html', r'''async function initApp(){
  applyTelegramTheme();''', r'''async function initApp(){
  applyTelegramTheme();
  document.querySelectorAll('[data-ic]').forEach(function(el){ el.innerHTML = ic(el.getAttribute('data-ic'), parseInt(el.getAttribute('data-sz') || '22', 10)); });'''))

for emo, name in [('♂️','male'),('♀️','female'),('🔥','flame'),('💪','dumbbell'),('⚡','zap'),('🪑','chair'),('🚶','walk'),('🏃','run')]:
    PATCHES.append(('static/index.html',
        '<span class="ic">' + emo + '</span>',
        '<span class="ic" style="color:var(--accent)"><span data-ic="' + name + '" data-sz="22"></span></span>'))

PATCHES.append(('static/index.html', '<div class="stat-ic" style="background:var(--amber-dim)">🔥</div>', '<div class="stat-ic" style="background:var(--amber-dim);color:var(--amber)"><span data-ic="flame" data-sz="20"></span></div>'))
PATCHES.append(('static/index.html', '<div class="stat-ic" style="background:var(--blue-dim)">💧</div>', '<div class="stat-ic" style="background:var(--blue-dim);color:var(--blue)"><span data-ic="droplet" data-sz="20"></span></div>'))

PATCHES.append(('static/index.html', r'''$('homeTip').innerHTML = '<div class="tooltip">👋 <span><b>Привет!</b>''', r'''$('homeTip').innerHTML = '<div class="tooltip">' + ic('sparkles',17) + ' <span><b>Привет!</b>'''))

PATCHES.append(('static/index.html', r'''2:[['breakfast','Завтрак','🌅',.35],['dinner','Ужин','🌙',.35]],
    3:[['breakfast','Завтрак','🌅',.3],['lunch','Обед','🍽️',.4],['dinner','Ужин','🌙',.3]],
    4:[['breakfast','Завтрак','🌅',.25],['lunch','Обед','🍽️',.35],['snack','Перекус','🍎',.15],['dinner','Ужин','🌙',.25]],
    5:[['breakfast','Завтрак','🌅',.22],['lunch','Обед','🍽️',.32],['snack','Перекус','🍎',.12],['dinner','Ужин','🌙',.22],['snack','Поздний перекус','🥜',.12]],
    6:[['breakfast','Завтрак','🌅',.2],['snack','Перекус','🍎',.1],['lunch','Обед','🍽️',.3],['snack','Перекус','🥜',.1],['dinner','Ужин','🌙',.2],['snack','Перед сном','🥛',.1]]''',
r'''2:[['breakfast','Завтрак','sunrise',.35],['dinner','Ужин','moon',.35]],
    3:[['breakfast','Завтрак','sunrise',.3],['lunch','Обед','utensils',.4],['dinner','Ужин','moon',.3]],
    4:[['breakfast','Завтрак','sunrise',.25],['lunch','Обед','utensils',.35],['snack','Перекус','apple',.15],['dinner','Ужин','moon',.25]],
    5:[['breakfast','Завтрак','sunrise',.22],['lunch','Обед','utensils',.32],['snack','Перекус','apple',.12],['dinner','Ужин','moon',.22],['snack','Поздний перекус','nut',.12]],
    6:[['breakfast','Завтрак','sunrise',.2],['snack','Перекус','apple',.1],['lunch','Обед','utensils',.3],['snack','Перекус','nut',.1],['dinner','Ужин','moon',.2],['snack','Перед сном','milk',.1]]'''))

PATCHES.append(('static/index.html', r'''html += '<div class="meal-item"><div class="meal-thumb" id="thumb-' + logged.id + '">🥗</div>' +''', r'''html += '<div class="meal-item"><div class="meal-thumb" id="thumb-' + logged.id + '" style="color:var(--accent)">' + ic('bowl',22) + '</div>' +'''))
PATCHES.append(('static/index.html', r''''<div class="meal-thumb">' + slot[2] + '</div>' +''', r''''<div class="meal-thumb" style="color:var(--accent)">' + ic(slot[2],22) + '</div>' +'''))

PATCHES.append(('static/index.html', r'''function locCard(id, ic, name, desc){ return '<div class="loc-card pressable" onclick="selectedLocation=\'' + id + '\';loadWorkouts()"><span class="ic">' + ic + '</span><span style="font-weight:800;font-size:15px">' + name + '</span><span class="subtle" style="font-size:12px">' + desc + '</span></div>'; }''', r'''function locCard(id, icn, name, desc){ return '<div class="loc-card pressable" onclick="selectedLocation=\'' + id + '\';loadWorkouts()"><span class="ic" style="color:var(--accent)">' + ic(icn,26) + '</span><span style="font-weight:800;font-size:15px">' + name + '</span><span class="subtle" style="font-size:12px">' + desc + '</span></div>'; }'''))
PATCHES.append(('static/index.html', r'''function typeCard(id, ic, name, desc){ return '<div class="loc-card pressable" onclick="selectedType=\'' + id + '\';loadWorkouts()"><span class="ic">' + ic + '</span><span style="font-weight:800;font-size:15px">' + name + '</span><span class="subtle" style="font-size:12px">' + desc + '</span></div>'; }''', r'''function typeCard(id, icn, name, desc){ return '<div class="loc-card pressable" onclick="selectedType=\'' + id + '\';loadWorkouts()"><span class="ic" style="color:var(--accent)">' + ic(icn,26) + '</span><span style="font-weight:800;font-size:15px">' + name + '</span><span class="subtle" style="font-size:12px">' + desc + '</span></div>'; }'''))
PATCHES.append(('static/index.html', r'''locCard('home','🏠','Дома','Без инвентаря') + locCard('outdoor','🌳','На улице','Площадка / парк') +''', r'''locCard('home','home','Дома','Без инвентаря') + locCard('outdoor','trees','На улице','Площадка / парк') +'''))
PATCHES.append(('static/index.html', r'''locCard('gym','🏋️','В зале','Тренажёры и гантели') + locCard('any','🌍','Везде','Все варианты')''', r'''locCard('gym','dumbbell','В зале','Тренажёры и гантели') + locCard('any','globe','Везде','Все варианты')'''))
PATCHES.append(('static/index.html', r'''typeCard('strength','💪','Силовые','Мышцы и сила') + typeCard('cardio','❤️','Кардио','Выносливость') +''', r'''typeCard('strength','dumbbell','Силовые','Мышцы и сила') + typeCard('cardio','heart','Кардио','Выносливость') +'''))
PATCHES.append(('static/index.html', r'''typeCard('calisthenics','🤸','Калистеника','Свой вес') + typeCard('hiit','⚡','HIIT','Жиросжигание')''', r'''typeCard('calisthenics','person','Калистеника','Свой вес') + typeCard('hiit','zap','HIIT','Жиросжигание')'''))

PATCHES.append(('static/index.html', r'''const names = { breakfast:['Завтрак','🌅'], lunch:['Обед','🍽️'], snack:['Перекус','🍎'], dinner:['Ужин','🌙'] };''', r'''const names = { breakfast:['Завтрак','sunrise'], lunch:['Обед','utensils'], snack:['Перекус','apple'], dinner:['Ужин','moon'] };'''))
PATCHES.append(('static/index.html', r'''<div class="card text-center pressable" style="cursor:pointer" onclick="addWater()"><div style="font-size:22px">💧</div>''', r'''<div class="card text-center pressable" style="cursor:pointer" onclick="addWater()"><div style="color:var(--blue)">' + ic('droplet',22) + '</div>'''))
PATCHES.append(('static/index.html', r'''<div class="card text-center"><div style="font-size:22px">🔥</div>''', r'''<div class="card text-center"><div style="color:var(--amber)">' + ic('flame',22) + '</div>'''))
PATCHES.append(('static/index.html', r'''style="font-size:13px">🛒 Список покупок за неделю</button>' +''', r'''style="font-size:13px;gap:6px">' + ic('cart',15) + ' Список покупок за неделю</button>' +'''))
PATCHES.append(('static/index.html', r'''<div class="loc-card pressable" onclick="openMealSelector(\'' + k + '\')"><span class="ic">' + names[k][1] + '</span>''', r'''<div class="loc-card pressable" onclick="openMealSelector(\'' + k + '\')"><span class="ic" style="color:var(--accent)">' + ic(names[k][1],24) + '</span>'''))

PATCHES.append(('static/index.html', r'''<div class="recipe-hero" id="mealHero"><span>🥗</span></div>' +''', r'''<div class="recipe-hero" id="mealHero"><span style="color:var(--accent);display:flex">' + ic('bowl',42) + '</span></div>' +'''))
PATCHES.append(('static/index.html', r'''<div class="recipe-hero" id="mealHero2"><span>🥗</span></div>' +''', r'''<div class="recipe-hero" id="mealHero2"><span style="color:var(--accent);display:flex">' + ic('bowl',42) + '</span></div>' +'''))
PATCHES.append(('static/index.html', '''onclick="loadNextMeal()">🔄 Другое</button>' +''', '''onclick="loadNextMeal()">' + ic('refresh',15) + ' Другое</button>' +'''))
PATCHES.append(('static/index.html', '''onclick="showRecipeDetail()">👨‍🍳 Готовить</button></div></div>';''', '''onclick="showRecipeDetail()">' + ic('chef',15) + ' Готовить</button></div></div>';'''))
PATCHES.append(('static/index.html', '''onclick="logCurrentMeal()">📝 Записать в дневник</button></div></div>';''', '''onclick="logCurrentMeal()">' + ic('pen',15) + ' Записать в дневник</button></div></div>';'''))

PATCHES.append(('static/index.html', '''    loadMealImage(r.id, 'mealHeroImg');\n''', ''))

PATCHES.append(('static/index.html', r'''    if(isProgram && currentProgramId){
      const p = await api('/api/user/program/progress', { method:'POST', body:{ tg_id: currentUser.tg_id } });
      if(p.completed) setTimeout(() => showSuccess('Программа завершена! 🎉'), 1200);
    }''', r'''    if(isProgram && currentProgramId){
      try{
        const p = await api('/api/user/program/progress', { method:'POST', body:{ tg_id: currentUser.tg_id } });
        if(p.completed) setTimeout(() => showSuccess('Программа завершена! 🎉'), 1200);
      }catch(e2){ /* день программы без активной программы — тренировка сохранена, это ок */ }
    }'''))

def apply():
    files = {}
    ok, fail = 0, 0
    for p in PATCHES:
        fname, old, new = p[0], p[1], p[2]
        mode = p[3] if len(p) > 3 else 'ONE'
        if fname not in files:
            path = ROOT / fname
            if not path.exists():
                print('ФАЙЛ НЕ НАЙДЕН: ' + fname); fail += 1; continue
            files[fname] = path.read_text(encoding='utf-8')
        text = files[fname]
        count = text.count(old)
        if mode == 'ALL':
            if count == 0:
                print('ПРОПУСК (уже применено?): %s :: %s...' % (fname, old[:60])); continue
            files[fname] = text.replace(old, new)
            ok += 1
            print('OK   %s: заменено %d x %s...' % (fname, count, old[:50]))
        else:
            if count != 1:
                print('ОШИБКА: %s: найдено %d вхождений (ожидалось 1) для: %s...' % (fname, count, old[:60]))
                fail += 1
                continue
            files[fname] = text.replace(old, new, 1)
            ok += 1
            print('OK   %s: %s...' % (fname, old[:50]))
    if fail:
        print('\nАВАРИЙНАЯ ОСТАНОВКА: %d замен не совпало. Файлы НЕ изменены.' % fail)
        sys.exit(1)
    for fname, text in files.items():
        path = ROOT / fname
        shutil.copy2(path, path.with_suffix(path.suffix + '.bak-' + ts))
        path.write_text(text, encoding='utf-8')
        print('ЗАПИСАНО: %s (бэкап: %s.bak-%s)' % (fname, fname, ts))
    print('\nГотово: %d правок применено.' % ok)

if __name__ == '__main__':
    apply()
