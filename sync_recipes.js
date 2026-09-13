// GuideFit: синхронизация рецептов (FatSecret → Gemini → Pexels) → recipes.json
// Запуск: node sync_recipes.js (переменные в .env: GEMINI_API_KEY, PEXELS_API_KEY; опционально FS_CLIENT_ID/FS_CLIENT_SECRET)
require('dotenv').config();
const fs = require('fs');

const PEXELS = process.env.PEXELS_API_KEY;
const GEMINI = process.env.GEMINI_API_KEY;
const FS_ID = process.env.FS_CLIENT_ID;
const FS_SEC = process.env.FS_CLIENT_SECRET;
const PER_CAT = 100;
const CATS = [
  { cat: 'breakfast', fs: 'healthy breakfast', gem: 'полезные завтраки (250–450 ккал)' },
  { cat: 'lunch',     fs: 'healthy lunch',     gem: 'полезные обеды (350–550 ккал)' },
  { cat: 'dinner',    fs: 'healthy dinner',    gem: 'полезные ужины (250–450 ккал)' },
  { cat: 'snack',     fs: 'healthy snack',     gem: 'полезные перекусы (100–300 ккал)' }
];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let nextId = 1;
const out = [];
function log(m){ console.log(new Date().toISOString().slice(11,19), m); }

async function pexels(query){
  if(!PEXELS || !query) return '';
  try{
    const r = await fetch('https://api.pexels.com/v1/search?query=' + encodeURIComponent(query + ' food') + '&per_page=1&orientation=landscape', { headers: { Authorization: PEXELS } });
    const d = await r.json();
    return (d.photos && d.photos[0]) ? d.photos[0].src.medium : '';
  }catch(e){ return ''; }
}
async function gemini(prompt){
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=' + GEMINI, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.9, maxOutputTokens: 8192 } })
  });
  const d = await r.json();
  if(!d.candidates || !d.candidates[0]) throw new Error('Gemini: ' + JSON.stringify(d).slice(0, 200));
  return d.candidates[0].content.parts[0].text;
}
function parseJson(t){
  t = t.replace(/```json|```/g, '').trim();
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if(a === -1 || b === -1) throw new Error('no json');
  return JSON.parse(t.slice(a, b + 1));
}
async function geminiJson(prompt){
  for(let i = 0; i < 3; i++){
    try{ return parseJson(await gemini(prompt)); }
    catch(e){ log('gemini retry ' + (i+1) + ': ' + e.message); await sleep(3000); }
  }
  return null;
}
let fsTokenCache = null;
async function fsToken(){
  if(fsTokenCache && fsTokenCache.exp > Date.now()) return fsTokenCache.token;
  const r = await fetch('https://oauth.fatsecret.com/connect/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&client_id=' + encodeURIComponent(FS_ID) + '&client_secret=' + encodeURIComponent(FS_SEC)
  });
  const d = await r.json();
  if(!d.access_token) throw new Error('FS token: ' + JSON.stringify(d).slice(0, 200));
  fsTokenCache = { token: d.access_token, exp: Date.now() + (d.expires_in - 60) * 1000 };
  return d.access_token;
}
async function fsApi(method, params){
  const token = await fsToken();
  const body = Object.assign({ method, format: 'json' }, params);
  const r = await fetch('https://platform.fatsecret.com/rest/server.api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Bearer ' + token },
    body: Object.keys(body).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(body[k])).join('&')
  });
  return r.json();
}
async function genViaGemini(catDef){
  const items = [];
  for(let start = 0; start < PER_CAT; start += 10){
    const prompt = 'Ты — нутрициолог и автор кулинарных книг. Придумай 10 разных простых русских блюд категории «' + catDef.gem + '». ' +
      'Аудитория — женщины 40+ без опыта готовки, цель — похудение: простые доступные продукты, 3–5 шагов. ' +
      'Верни СТРОГО JSON-массив из 10 объектов без markdown: {"title":"короткое русское название","calories":число,"protein":число,"fat":число,"carbs":число,' +
      '"ingredients":["Продукт количество ед" — 4–6 позиций с граммовками],"steps":["шаг 1","шаг 2","шаг 3"],' +
      '"desc":"одно предложение: польза для похудения","photo":"английский запрос для фото (2-3 слова)"}. Блюда РАЗНЫЕ и аппетитные.';
    const arr = await geminiJson(prompt);
    if(!arr){ log('gemini batch failed @' + start); continue; }
    for(const it of arr){
      if(!it.title || !it.calories) continue;
      items.push({ title: String(it.title).trim(),
        calories: Math.round(Number(it.calories)) || 0, protein: Math.round(Number(it.protein)) || 0,
        fat: Math.round(Number(it.fat)) || 0, carbs: Math.round(Number(it.carbs)) || 0,
        ingredients: (it.ingredients || []).map(x => String(x).trim()).filter(Boolean).slice(0, 8),
        steps: (it.steps || []).map(x => String(x).trim()).filter(Boolean).slice(0, 6),
        desc: String(it.desc || '').trim(), photo: String(it.photo || it.title).trim() });
    }
    log(catDef.cat + ': gemini ' + items.length + '/' + PER_CAT);
    await sleep(1500);
  }
  return items.slice(0, PER_CAT);
}
async function genViaFatSecret(catDef){
  const ids = [];
  for(let page = 0; page < 6 && ids.length < PER_CAT; page++){
    try{
      const d = await fsApi('recipes.search', { search_expression: catDef.fs, page_number: page, max_results: 50 });
      const list = (d.recipes && d.recipes.recipe) || [];
      list.forEach(r => { if(r.recipe_id && ids.length < PER_CAT) ids.push(r.recipe_id); });
    }catch(e){ log('fs search: ' + e.message); }
    await sleep(400);
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
    await sleep(300);
  }
  const items = [];
  for(let i = 0; i < raw.length; i += 10){
    const batch = raw.slice(i, i + 10);
    const prompt = 'Переведи и адаптируй рецепты для русскоязычного приложения похудения (женщины 40+). Аппетитные русские названия, ингредиенты с мерами (г, мл, шт), 3–5 коротких шагов, desc — одно предложение о пользе. КБЖУ НЕ меняй. ' +
      'Верни СТРОГО JSON-массив {"i":номер,"title":"...","ingredients":[...],"steps":[...],"desc":"...","photo":"английский запрос 2-3 слова"} без markdown.\n' +
      JSON.stringify(batch.map((b, j) => ({ i: j, name: b.name, desc: b.desc, ing: b.ing, dir: b.dir })));
    const arr = await geminiJson(prompt);
    if(!arr) continue;
    arr.forEach(a => {
      const src = batch[a.i];
      if(!src || !a.title) return;
      items.push({ title: String(a.title).trim(), calories: src.calories, protein: src.protein, fat: src.fat, carbs: src.carbs,
        ingredients: (a.ingredients || []).map(x => String(x).trim()).filter(Boolean).slice(0, 8),
        steps: (a.steps || []).map(x => String(x).trim()).filter(Boolean).slice(0, 6),
        desc: String(a.desc || '').trim(), photo: String(a.photo || src.name).trim() });
    });
    log(catDef.cat + ': переведено ' + items.length + '/' + raw.length);
    await sleep(1500);
  }
  return items.slice(0, PER_CAT);
}
(async () => {
  if(!GEMINI){ console.error('Нет GEMINI_API_KEY в .env'); process.exit(1); }
  const useFS = !!(FS_ID && FS_SEC);
  log('режим: ' + (useFS ? 'FatSecret+Gemini+Pexels' : 'Gemini+Pexels'));
  for(const catDef of CATS){
    let items = [];
    if(useFS){
      try{ items = await genViaFatSecret(catDef); }catch(e){ log('fatsecret: ' + e.message); items = []; }
      if(items.length < 50) items = await genViaGemini(catDef);
    } else items = await genViaGemini(catDef);
    log(catDef.cat + ': фото для ' + items.length + '…');
    for(let i = 0; i < items.length; i++){
      items[i].image_url = await pexels(items[i].photo || items[i].title);
      if(i % 25 === 0) log(catDef.cat + ' фото ' + i + '/' + items.length);
      await sleep(120);
    }
    for(const it of items){
      const kcal = it.calories || 300;
      out.push({ id: nextId++, title: it.title, category: catDef.cat,
        calories: kcal, protein: it.protein || Math.round(kcal * 0.25 / 4), fat: it.fat || Math.round(kcal * 0.3 / 9), carbs: it.carbs || Math.round(kcal * 0.45 / 4),
        description: it.desc || 'Простое полезное блюдо из доступных продуктов.',
        benefits: 'Белок ' + (it.protein || '—') + ' г на порцию — сытость надолго.',
        ingredients: it.ingredients, recipe_steps: it.steps,
        image_url: it.image_url || '',
        goals: kcal > 650 ? ['maintain', 'gain'] : ['lose', 'maintain', 'gain'],
        photo: it.photo });
    }
    log(catDef.cat + ' ГОТОВО: ' + items.length);
  }
  fs.writeFileSync('recipes.json.bak', fs.readFileSync('recipes.json'));
  fs.writeFileSync('recipes.json', JSON.stringify(out, null, 1));
  log('ИТОГО: ' + out.length + ' рецептов → recipes.json (backup: recipes.json.bak)');
})();
