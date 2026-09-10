/* GuideFit — генерация блюд и фото через Gemini API (v3: быстрый ответ, фото в фоне) */
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const db = require('./db');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const IMG_DIR = path.join(__dirname, 'static', 'ai-img');
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

const CATEGORIES = ['breakfast', 'lunch', 'dinner', 'snack'];
const CATEGORY_NAMES = { breakfast: 'завтрак', lunch: 'обед', dinner: 'ужин', snack: 'перекус' };
const GOALS = ['lose', 'maintain', 'gain'];
const GOAL_NAMES = {
    lose: 'похудение — порция лёгкая или средняя, белок приоритетен, ккал умеренно',
    maintain: 'поддержание веса — сбалансированное блюдо',
    gain: 'набор массы — калорийная сытная порция, много белка'
};
const KCAL_RANGE = { breakfast: '300-550', lunch: '450-750', dinner: '400-700', snack: '150-400' };
const TEXT_MODELS = [process.env.GEMINI_TEXT_MODEL, 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash'].filter(Boolean);
const IMAGE_MODELS = [process.env.GEMINI_IMAGE_MODEL, 'gemini-2.5-flash-image', 'gemini-3.1-flash-image', 'gemini-2.0-flash-preview-image-generation'].filter(Boolean);
const MIN_INTERVAL = parseInt(process.env.GEMINI_MIN_INTERVAL || '1500', 10);
const POOL_TARGET = parseInt(process.env.POOL_TARGET || '100', 10);
const AI_ID_START = 100000;

const KEY_LIST = [...new Set([process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY, process.env.GEMINI_KEY].filter(k => k && k.trim()).map(k => k.trim()))];
const AIS = KEY_LIST.map(k => new GoogleGenerativeAI(k));

let lastCallAt = 0;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function throttle() {
    const wait = Math.max(0, MIN_INTERVAL - (Date.now() - lastCallAt));
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
}

function dbGet(sql, params = []) { return new Promise((res, rej) => db.get(sql, params, (e, r) => e ? rej(e) : res(r))); }
function dbAll(sql, params = []) { return new Promise((res, rej) => db.all(sql, params, (e, r) => e ? rej(e) : res(r))); }
function dbRun(sql, params = []) { return new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); })); }

const RECIPE_SCHEMA = {
    type: 'OBJECT',
    properties: {
        title: { type: 'STRING' },
        description: { type: 'STRING', description: '1-2 предложения о блюде' },
        benefits: { type: 'STRING', description: 'Одно предложение: почему блюдо подходит под цель' },
        calories: { type: 'NUMBER' },
        protein: { type: 'NUMBER' },
        fat: { type: 'NUMBER' },
        carbs: { type: 'NUMBER' },
        ingredients: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, amount: { type: 'NUMBER' }, unit: { type: 'STRING', description: 'г, мл, шт, ч.л., ст.л.' } }, required: ['name', 'amount', 'unit'] } },
        recipe_steps: { type: 'ARRAY', items: { type: 'STRING' }, description: '7-10 подробных шагов с граммовками, температурами и минутами' }
    },
    required: ['title', 'description', 'benefits', 'calories', 'protein', 'fat', 'carbs', 'ingredients', 'recipe_steps']
};

function kcalPlausible(r) {
    const est = 4 * (+r.protein || 0) + 4 * (+r.carbs || 0) + 9 * (+r.fat || 0);
    return r.calories > 0 && est > 0 && Math.abs(est - r.calories) / r.calories <= 0.25;
}

const SEEDS = [
    'средиземноморская кухня', 'итальянская кухня', 'азиатские мотивы', 'скандинавская простота',
    'мексиканская кухня', 'французская деревенская', 'ближневосточные специи', 'фермерская сковорода',
    'с морепродуктами', 'с индейкой', 'с лососем', 'с говядиной', 'с курицей',
    'с тофу', 'с чечевицей', 'с нутом', 'с гречкой', 'с булгуром', 'с киноа', 'с бататом',
    'со шпинатом', 'с печенью', 'с творогом', 'запечённое в духовке', 'тушёное в одной сковороде',
    'на гриле', 'в мультиварке', 'холодное (без готовки)', 'сезонное', 'согревающее',
    'пикантное с лаймом', 'с имбирём и чесноком', 'свежие травы', 'кремовая текстура',
    'хрустящая корочка', 'яйцо всмятку', 'копчёный акцент'
];

function extractJson(text) {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no json in response');
    return JSON.parse(m[0]);
}

function normalizeRecipe(r) {
    if (!r.title || typeof r.title !== 'string') throw new Error('no title');
    if (!Array.isArray(r.ingredients) || r.ingredients.length < 3) throw new Error('bad ingredients');
    if (!Array.isArray(r.recipe_steps) || r.recipe_steps.length < 5) throw new Error('bad steps');
    r.title = r.title.trim().replace(/["«»]/g, '');
    r.calories = Math.round(+r.calories || 0);
    r.protein = Math.round((+r.protein || 0) * 10) / 10;
    r.fat = Math.round((+r.fat || 0) * 10) / 10;
    r.carbs = Math.round((+r.carbs || 0) * 10) / 10;
    if (!kcalPlausible(r)) throw new Error('implausible macros');
    return r;
}

function buildPrompt(category, goal, banTitles) {
    const seed = SEEDS[Math.floor(Math.random() * SEEDS.length)];
    return `Ты — опытный шеф-повар и нутрициолог. Придумай ОДНО конкретное, реально существующее блюдо для ${CATEGORY_NAMES[category]}а.

Думай строго в таком порядке (ответ — только JSON):
1. ВЫБЕРИ блюдо: основной ингредиент + способ готовки + 1-2 ярких компонента. Название должно точно описывать состав блюда.
2. СОСТАВЬ ингредиенты: ТОЛЬКО продукты, которые реально входят в ЭТО блюдо (5-9 позиций, граммовки на 1 порцию). Запрещено добавлять продукты, не следящие из названия.
3. ПОСЧИТАЙ КБЖУ именно по этим ингредиентам на порцию: белки*4 + жиры*9 + углеводы*4 ≈ калорийность (отклонение не более 15%).
4. НАПИШИ 7-10 подробных шагов приготовления: как нарезать (размер кусочков), температура духовки/огня, время каждого этапа в минутах, что должно получиться. По шагам можно приготовить блюдо с нуля. Без воды, без "приятного аппетита".

Ограничения: приём пищи — ${CATEGORY_NAMES[category]}; калорийность порции примерно ${KCAL_RANGE[category]} ккал; цель — ${GOAL_NAMES[goal] || goal}; акцент вкуса — ${seed}. Никакого алкоголя.` +
        (banTitles && banTitles.length ? `\nНе предлагай блюда с такими названиями: ${banTitles.join('; ')}.` : '');
}

async function generateRecipe(category, goal, banTitles) {
    if (!AIS.length) throw new Error('Нет ключа: задай GEMINI_API_KEY в .env');
    const prompt = buildPrompt(category, goal, banTitles);
    const variants = [{ schema: true }, { schema: true }, { schema: false }, { schema: false }];
    let lastErr = null;
    for (let attempt = 0; attempt < variants.length; attempt++) {
        const ai = AIS[attempt % AIS.length];
        const modelName = TEXT_MODELS[attempt % TEXT_MODELS.length];
        try {
            await throttle();
            const t0 = Date.now();
            const genCfg = { temperature: 0.8 };
            if (variants[attempt].schema) { genCfg.responseMimeType = 'application/json'; genCfg.responseSchema = RECIPE_SCHEMA; }
            const model = ai.getGenerativeModel({ model: modelName, generationConfig: genCfg });
            const text = await model.generateContent(prompt + (variants[attempt].schema ? '' : '\nОтветь одним JSON-объектом без пояснений и markdown.')).then(x => x.response.text());
            const r = normalizeRecipe(extractJson(text));
            console.log(`[gemini] текст: ${modelName} · ${Date.now() - t0}мс · ${r.title}`);
            return r;
        } catch (e) {
            lastErr = e;
            console.error(`[gemini] текст ${modelName} не вышел: ${e.message}`);
            await sleep(2000);
        }
    }
    throw new Error('Gemini text failed: ' + (lastErr && lastErr.message));
}

async function generateImageBuffer(title, category) {
    if (!AIS.length) return null;
    const prompt = `Professional appetizing food photography of the dish "${title}" (${CATEGORY_NAMES[category]}), served on a ceramic plate, soft natural window light, 45-degree angle, shallow depth of field, restaurant quality, vibrant fresh colors, no text, no watermark, no people.`;
    let tries = 0;
    for (let m = 0; m < IMAGE_MODELS.length && tries < 4; m++) {
        for (let k = 0; k < AIS.length && tries < 4; k++, tries++) {
            try {
                await throttle();
                const t0 = Date.now();
                const model = AIS[(m + k) % AIS.length].getGenerativeModel({ model: IMAGE_MODELS[m] });
                const result = await model.generateContent({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: { responseModalities: ['IMAGE'] }
                });
                const cand = result.response.candidates && result.response.candidates[0];
                const parts = (cand && cand.content && cand.content.parts) || [];
                for (const p of parts) {
                    if (p.inlineData && p.inlineData.data) {
                        console.log(`[gemini] фото: ${IMAGE_MODELS[m]} · ${Date.now() - t0}мс · ${title}`);
                        return Buffer.from(p.inlineData.data, 'base64');
                    }
                }
            } catch (e) {
                console.error(`[gemini] фото ${IMAGE_MODELS[m]} не вышло: ${e.message}`);
            }
        }
    }
    return null;
}

async function ensureImageById(id, title, category) {
    const row = await dbGet('SELECT image_url FROM recipes WHERE id = ?', [id]);
    if (row && row.image_url && row.image_url.length > 3) return row.image_url;
    const buf = await generateImageBuffer(title, category);
    if (!buf) return '';
    const file = id + '.jpg';
    fs.writeFileSync(path.join(IMG_DIR, file), buf);
    const url = '/ai-img/' + file;
    await dbRun('UPDATE recipes SET image_url = ? WHERE id = ?', [url, id]);
    return url;
}

/* фото в фоне: сервер не ждёт, клиент подхватывает готовое */
const inflight = new Set();
function queueImage(id, title, category) {
    if (inflight.has(id)) return;
    inflight.add(id);
    ensureImageById(id, title, category)
        .then(u => { if (u) console.log(`[gemini] фото готово: ${u}`); })
        .catch(e => console.error('queueImage error:', e.message))
        .finally(() => inflight.delete(id));
}

async function insertRecipe(r, category, goal) {
    const dup = await dbGet('SELECT id FROM recipes WHERE category = ? AND lower(title) = lower(?)', [category, r.title]);
    if (dup) throw new Error('duplicate:' + r.title);
    for (let i = 0; i < 3; i++) {
        const maxRow = await dbGet('SELECT COALESCE(MAX(id), 0) + 1 AS nid FROM recipes', []);
        const id = Math.max(maxRow.nid, AI_ID_START);
        try {
            await dbRun('INSERT INTO recipes (id, title, category, calories, protein, fat, carbs, description, benefits, ingredients, recipe_steps, image_url, goals) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                [id, r.title, category, r.calories, r.protein, r.fat, r.carbs, r.description || '', r.benefits || '', JSON.stringify(r.ingredients), JSON.stringify(r.recipe_steps), '', JSON.stringify([goal])]);
            return id;
        } catch (e) {
            if (/UNIQUE|constraint/i.test(e.message)) await sleep(1000); else throw e;
        }
    }
    throw new Error('insert failed');
}

function decorate(row, imageUrl) {
    const r = Object.assign({}, row);
    try { r.ingredients = JSON.parse(r.ingredients || '[]'); } catch (e) { r.ingredients = []; }
    try { r.recipe_steps = JSON.parse(r.recipe_steps || '[]'); } catch (e) { r.recipe_steps = []; }
    try { r.goals = JSON.parse(r.goals || '[]'); } catch (e) { r.goals = []; }
    r.image_url = imageUrl || r.image_url || '';
    r.ai = true;
    return r;
}

async function countCategory(category) {
    const row = await dbGet('SELECT COUNT(*) AS n FROM recipes WHERE id >= ? AND category = ?', [AI_ID_START, category]);
    return row ? row.n : 0;
}

/* ГЛАВНЫЙ ПОТОК: пул < 100 → генерируем; пул = 100 → случайное из пула. Фото — в фоне. */
async function handleMeal(req, res) {
    try {
        const { category, goal, exclude_id } = req.body || {};
        if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Missing category' });
        const g = GOALS.includes(goal) ? goal : 'maintain';
        const cnt = await countCategory(category);
        if (cnt >= POOL_TARGET) {
            let row = await dbGet('SELECT * FROM recipes WHERE id >= ? AND category = ? AND goals LIKE ? AND id != ? ORDER BY RANDOM() LIMIT 1',
                [AI_ID_START, category, '%' + g + '%', exclude_id || -1]);
            if (!row) row = await dbGet('SELECT * FROM recipes WHERE id >= ? AND category = ? AND id != ? ORDER BY RANDOM() LIMIT 1',
                [AI_ID_START, category, exclude_id || -1]);
            if (!row) return res.status(404).json({ error: 'Recipe not found' });
            if (!row.image_url) queueImage(row.id, row.title, row.category);
            return res.json({ recipe: decorate(row, row.image_url) });
        }
        try {
            const bans = (await dbAll('SELECT title FROM recipes WHERE category = ? ORDER BY RANDOM() LIMIT 10', [category])).map(x => x.title);
            const r = await generateRecipe(category, g, bans);
            const id = await insertRecipe(r, category, g);
            queueImage(id, r.title, category);
            const row = await dbGet('SELECT * FROM recipes WHERE id = ?', [id]);
            return res.json({ recipe: decorate(row, ''), pool: cnt + 1, pool_target: POOL_TARGET });
        } catch (e) {
            console.error('ai generate failed, fallback to seed:', e.message);
            fallbackSeed(category, goal, exclude_id, res);
        }
    } catch (e) {
        console.error('handleMeal error:', e);
        res.status(500).json({ error: 'Не получилось подобрать блюдо, попробуй ещё раз' });
    }
}

function fallbackSeed(category, goal, exclude_id, res) {
    let sql = "SELECT * FROM recipes WHERE category = ? AND id < ?";
    let params = [category, AI_ID_START];
    if (goal) { sql += " AND (goals LIKE ? OR goals IS NULL OR goals = '')"; params.push('%' + goal + '%'); }
    if (exclude_id) { sql += " AND id != ?"; params.push(exclude_id); }
    sql += " ORDER BY RANDOM() LIMIT 1";
    db.get(sql, params, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Recipe not found' });
        if (row.ingredients) try { row.ingredients = JSON.parse(row.ingredients); } catch (e) { }
        if (row.recipe_steps) try { row.recipe_steps = JSON.parse(row.recipe_steps); } catch (e) { }
        if (row.goals) try { row.goals = JSON.parse(row.goals); } catch (e) { row.goals = [row.goals]; }
        res.json({ recipe: row });
    });
}

async function handleAiMeal(req, res) { return handleMeal(req, res); }

async function poolStatus(req, res) {
    try {
        const rows = await dbAll('SELECT category, COUNT(*) AS n FROM recipes WHERE id >= ? GROUP BY category', [AI_ID_START]);
        res.json({ keys_configured: AIS.length, text_models: TEXT_MODELS, categories: rows, pool_target: POOL_TARGET });
    } catch (e) { res.status(500).json({ error: e.message }); }
}

module.exports = { CATEGORIES, GOALS, generateRecipe, insertRecipe, ensureImageById, queueImage, countCategory, handleMeal, handleAiMeal, poolStatus, keysCount: () => AIS.length, hasKey: () => AIS.length > 0 };
