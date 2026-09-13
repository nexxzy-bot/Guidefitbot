// До-синхронизация: добирает категории до 100 штук, не трогая готовое. Терпеливо ждёт квоту Gemini.
require('dotenv').config();
const fs = require('fs');
const PEXELS = process.env.PEXELS_API_KEY;
const GEMINI = process.env.GEMINI_API_KEY;
const FS_ID = process.env.FS_CLIENT_ID;
const FS_SEC = process.env.FS_CLIENT_SECRET;
const CATS = [
  { cat: 'dinner', fs: 'healthy dinner', gem: 'полезные ужины (250–450 ккал)' },
  { cat: 'snack', fs: 'healthy snack', gem: 'полезные перекусы (100–300 ккал)' },
  { cat: 'breakfast', fs: 'healthy breakfast', gem: 'полезные завтраки (250–450 ккал)' },
  { cat: 'lunch', fs: 'healthy lunch', gem: 'полезные обеды (350–550 ккал)' }
];
const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(m){ console.log(new Date().toISOString().slice(11,19), m); }
let recipes = JSON.parse(fs.readFileSync('recipes.json', 'utf8'));
let nextId = Math.max.apply(null, recipes.map(r => r.id)) + 1;
async function pexels(q){
  if(!PEXELS || !q) return '';
  try{
    const r = await fetch('https://api.pexels.com/v1/search?query=' + encodeURIComponent(q + ' food') + '&per_page=1&orientation=landscape', { headers: { Authorization: PEXELS } });
    const d = await r.json();
    return (d.photos && d.photos[0]) ? d.photos[0].src.medium : '';
  }catch(e){ return ''; }
}
async function gemini(prompt, tries){
  let wait = 20000;
  for(let i = 0; i < (tries || 8); i++){
    try{
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=' + GEMINI, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.9, maxOutputTokens: 8192 } })
      });
      const d = await r.json();
      if(d.candidates && d.candidates[0]) return d.candidates[0].content.parts[0].text;
      if(d.error && d.error.code === 429){ log('квота, жду ' + wait/1000 + 'с…'); await sleep(wait); wait = Math.min(wait * 2, 300000); continue; }
      throw new Error(JSON.stringify(d).slice(0, 120));
    }catch(e){ log('gemini: ' + e.message); await sleep(10000); }
  }
  return null;
}
function parseJson(t){
  t = t.replace(/```json|```/g, '').trim();
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if(a === -1 || b === -1) throw new Error('no json');
  return JSON.parse(t.slice(a, b + 1));
}
let fsTok = null;
async function fsToken(){
  if(fsTok && fsTok.exp > Date.now()) return fsTok.t;
  const r = await fetch('https://oauth.fatsecret.com/connect/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&client_id=' + encodeURIComponent(FS_ID) + '&client_secret=' + encodeURIComponent(FS_SEC) });
  const d = await r.json();
  if(!d.access_token) throw new Error('FS token');
  fsTok = { t: d.access_token, exp: Date.now() + (d.expires_in - 60) * 1000 };
  return d.access_token;
}
async function fsApi(method, params){
  const t = await fsToken();
  const body = Object.assign({ method, format: 'json' }, params);
  const r = await fetch('https://platform.fatsecret.com/rest/server.api', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Bearer ' + t },
    body: Object.keys(body).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(body[k])).join('&') });
  return r.json();
}
async function genGemini(catDef, need, skipTitles){
  const items = [];
  const skip = (skipTitles || []).join(' | ');
  for(let start = 0; items.length < need; start += 10){
    const prompt = 'Ты — нутрициолог и автор кулинарных книг. Придумай 10 разных простых русских блюд категории «' + catDef.gem + '». Аудитория — женщины 40+, цель похудение: доступные продукты, 3–5 шагов. ' +
      (skip ? 'НЕ повторяй эти блюда: ' + skip + '. ' : '') +
      'Верни СТРОГО JSON-массив из 10 объектов без markdown: {"title":"короткое русское название","calories":число,"protein":число,"fat":число,"carbs":число,"ingredients":["Продукт количество ед" 4–6 шт],"steps":["шаг 1","шаг 2","шаг 3"],"desc":"польза для похудения","photo":"английский запрос 2-3 слова"}.';
    const txt = await gemini(prompt);
    if(!txt){ log(catDef.cat + ': пакет не получен, пропускаю'); continue; }
    let arr = null;
    try{ arr = parseJson(txt); }catch(e){ log('json parse: ' + e.message); continue; }
    for(const it of arr){
      if(!it.title || !it.calories) continue;
      items.push({ title: String(it.title).trim(), calories: Math.round(Number(it.calories)) || 0,
        protein: Math.round(Number(it.protein)) || 0, fat: Math.round(Number(it.fat)) || 0, carbs: Math.round(Number(it.carbs)) || 0,
        ingredients: (it.ingredients || []).map(x => String(x).trim()).filter(Boolean).slice(0, 8),
        steps: (it.steps || []).map(x => String(x).trim()).filter(Boolean).slice(0, 6),
        desc: String(it.desc || '').trim(), photo: String(it.photo || it.title).trim() });
    }
    log(catDef.cat + ': gemini ' + items.length + '/' + need);
    await sleep(10000);
  }
  return items.slice(0, need);
}
async function genFS(catDef, need){
  if(!(FS_ID && FS_SEC)) return [];
  try{
    const ids = [];
    for(let page = 0; page < 6 && ids.length < need; page++){
      try{
        const d = await fsApi('recipes.search', { search_expression: catDef.fs, page_number: page, max_results: 50 });
        ((d.recipes && d.recipes.recipe) || []).forEach(r => { if(r.recipe_id && ids.length < need) ids.push(r.recipe_id); });
      }catch(e){ log('fs search: ' + e.message); }
      await sleep(1000);
    }
    const raw = [];
    for(const id of ids){
      try{
        const d = await fsApi('recipe.get', { recipe_id: id });
        const r = d.recipe;
        if(!r) continue;
        raw.push({ name: r.recipe_name, desc: r.recipe_description || '',
          ing: (r.ingredients && r.ingredients.ingredient ? [].concat(r.ingredients.ingredient) : []).map(i => i.ingredient_description || i.food_name || ''),
          dir: (r.directions && r.directions.direction ? [].concat(r.directions.direction) : []).map(x => x.direction_description || ''),
          calories: Number((r.nutrition || {}).calories) || 0, protein: Number((r.nutrition || {}).protein) || 0,
          fat: Number((r.nutrition || {}).fat) || 0, carbs: Number((r.nutrition || {}).carbohydrate) || 0 });
      }catch(e){}
      await sleep(600);
    }
    const items = [];
    for(let i = 0; i < raw.length && items.length < need; i += 10){
      const batch = raw.slice(i, i + 10);
      const txt = await gemini('Переведи рецепты для русского приложения похудения (женщины 40+): аппетитные русские названия, ингредиенты с мерами (г, мл, шт), 3–5 коротких шагов, desc — одно предложение. КБЖУ не меняй. Верни СТРОГО JSON-массив {"i":n,"title":"...","ingredients":[...],"steps":[...],"desc":"...","photo":"англ запрос"} без markdown.\n' +
        JSON.stringify(batch.map((b, j) => ({ i: j, name: b.name, desc: b.desc, ing: b.ing, dir: b.dir }))));
      if(!txt) continue;
      let arr = null;
      try{ arr = parseJson(txt); }catch(e){ continue; }
      arr.forEach(a => {
        const src = batch[a.i];
        if(!src || !a.title) return;
        items.push({ title: String(a.title).trim(), calories: src.calories, protein: src.protein, fat: src.fat, carbs: src.carbs,
          ingredients: (a.ingredients || []).map(x => String(x).trim()).filter(Boolean).slice(0, 8),
          steps: (a.steps || []).map(x => String(x).trim()).filter(Boolean).slice(0, 6),
          desc: String(a.desc || '').trim(), photo: String(a.photo || src.name).trim() });
      });
      log(catDef.cat + ': FS переведено ' + items.length + '/' + raw.length);
      await sleep(10000);
    }
    return items.slice(0, need);
  }catch(e){ log('FS: ' + e.message); return []; }
}
(async () => {
  for(const catDef of CATS){
    const have = recipes.filter(r => r.category === catDef.cat).length;
    const need = 100 - have;
    if(need <= 0){ log(catDef.cat + ': уже ' + have + ' — пропускаю'); continue; }
    log(catDef.cat + ': есть ' + have + ', добираю ' + need);
    let items = await genFS(catDef, need);
    if(items.length < need) items = items.concat(await genGemini(catDef, need - items.length, recipes.filter(r => r.category === catDef.cat).map(r => r.title)));
    for(let i = 0; i < items.length; i++){
      items[i].image_url = await pexels(items[i].photo || items[i].title);
      await sleep(150);
    }
    for(const it of items){
      const kcal = it.calories || 300;
      recipes.push({ id: nextId++, title: it.title, category: catDef.cat,
        calories: kcal, protein: it.protein || Math.round(kcal * 0.25 / 4), fat: it.fat || Math.round(kcal * 0.3 / 9), carbs: it.carbs || Math.round(kcal * 0.45 / 4),
        description: it.desc || 'Простое полезное блюдо из доступных продуктов.',
        benefits: 'Белок ' + (it.protein || '—') + ' г на порцию — сытость надолго.',
        ingredients: it.ingredients, recipe_steps: it.steps,
        image_url: it.image_url || '',
        goals: kcal > 650 ? ['maintain', 'gain'] : ['lose', 'maintain', 'gain'],
        photo: it.photo });
    }
    fs.writeFileSync('recipes.json', JSON.stringify(recipes, null, 1));
    log(catDef.cat + ' ГОТОВО (всего ' + recipes.filter(r => r.category === catDef.cat).length + '), файл сохранён');
  }
  const counts = {};
  recipes.forEach(r => counts[r.category] = (counts[r.category] || 0) + 1);
  log('ИТОГО: ' + recipes.length + ' рецептов ' + JSON.stringify(counts));
})();
