require('dotenv').config();
const TOKEN = process.env.TELEGRAM_TOKEN;
const APP_URL = process.env.MINIAPP_URL;
if (!TOKEN || !APP_URL) { console.error('Нужны TELEGRAM_TOKEN и MINIAPP_URL в .env'); process.exit(1); }
const tgApi = (m, b) => fetch('https://api.telegram.org/bot' + TOKEN + '/' + m, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(r => r.json()).catch(() => null);
let offset = -1;
async function loop() {
  try {
    const res = await fetch('https://api.telegram.org/bot' + TOKEN + '/getUpdates?offset=' + offset + '&timeout=30').then(r => r.json());
    if (res && res.ok) for (const u of res.result) {
      offset = u.update_id + 1;
      const m = u.message;
      if (!m || !m.chat) continue;
      if (m.text === '/start') {
        await tgApi('sendMessage', { chat_id: m.chat.id, text: 'Привет! Я GuideFit — питание и тренировки под твою цель. Жми кнопку:', reply_markup: { inline_keyboard: [[{ text: 'Открыть GuideFit', web_app: { url: APP_URL } }]] } });
        await tgApi('setChatMenuButton', { chat_id: m.chat.id, menu_button: { type: 'web_app', text: 'GuideFit', web_app: { url: APP_URL } } });
      }
      if (m.text === '/help') await tgApi('sendMessage', { chat_id: m.chat.id, text: 'Просто открой приложение кнопкой выше. Вопросы и пожелания пиши сюда — читаем всё.' });
    }
  } catch (e) {}
  setTimeout(loop, 100);
}
loop();
console.log('Бот GuideFit запущен');
