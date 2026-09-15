/* GuideFit — Telegram-бот.
   Задачи: кнопка запуска Mini App, привязка чата к аккаунту (для напоминаний тем,
   кто вошёл через ВК или анонимно) и отключение напоминаний по /stop.
   Схему БД не меняет — использует тот же db.js, что и сервер. */
require('dotenv').config();
const crypto = require('crypto');
const db = require('./db');

const TOKEN = process.env.TELEGRAM_TOKEN;
const APP_URL = process.env.MINIAPP_URL;
if (!TOKEN || !APP_URL) { console.error('Нужны TELEGRAM_TOKEN и MINIAPP_URL в .env'); process.exit(1); }

const LINK_TTL_SEC = 3600; // код привязки живёт час (как в /api/user/link/telegram)

const tgApi = (m, b) => fetch('https://api.telegram.org/bot' + TOKEN + '/' + m, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(b || {}),
  signal: AbortSignal.timeout(15000)
}).then(r => r.json()).catch(() => null);

function openKeyboard() {
  return { inline_keyboard: [[{ text: 'Открыть GuideFit', web_app: { url: APP_URL } }]] };
}

/* Привязка чата к аккаунту по одноразовому коду: /start link_<код> */
function linkChat(code, chatId) {
  return new Promise((resolve) => {
    if (!code) return resolve(null);
    db.get("SELECT tg_id, created_at FROM link_codes WHERE code = ?", [code], (e, row) => {
      if (e || !row) return resolve(null);
      if (Math.floor(Date.now() / 1000) - row.created_at > LINK_TTL_SEC) {
        db.run("DELETE FROM link_codes WHERE code = ?", [code]);
        return resolve(null);
      }
      db.run("UPDATE users SET notify_chat_id = ?, notify_enabled = 1 WHERE tg_id = ?",
        [String(chatId), row.tg_id], function (e2) {
          if (e2 || this.changes === 0) return resolve(null);
          db.run("DELETE FROM link_codes WHERE code = ?", [code]);
          resolve(row.tg_id);
        });
    });
  });
}

function disableNotifications(chatId) {
  return new Promise((resolve) => {
    db.run("UPDATE users SET notify_enabled = 0 WHERE tg_id = ? OR notify_chat_id = ?",
      [String(chatId), String(chatId)], function (e) {
        resolve(!e && this.changes > 0);
      });
  });
}

function randomId() { return crypto.randomBytes(4).toString('hex'); }

async function handleMessage(m) {
  if (!m || !m.chat) return;
  const chatId = m.chat.id;
  const raw = String(m.text || '').trim();
  // в группах команды приходят как /start@BotName — отрезаем суффикс
  const [cmdRaw, payloadRaw] = raw.split(/\s+/);
  const cmd = cmdRaw.split('@')[0].toLowerCase();
  const payload = String(payloadRaw || '').trim();

  if (cmd === '/start') {
    if (payload.indexOf('link_') === 0) {
      const tgId = await linkChat(payload.slice(5), chatId);
      if (tgId) {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: 'Готово! Напоминания подключены: утром о приёмах пищи, днём о взвешивании, вечером — если давно не тренировались.\n\nОтключить можно в приложении (Настройки → Уведомления) или командой /stop.',
          reply_markup: openKeyboard()
        });
      } else {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: 'Код не найден или устарел. Откройте приложение, зайдите в Настройки → Уведомления и получите новый код.',
          reply_markup: openKeyboard()
        });
      }
      return;
    }
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: 'Привет! Я GuideFit — питание и тренировки под твою цель. Жми кнопку:',
      reply_markup: openKeyboard()
    });
    await tgApi('setChatMenuButton', { chat_id: chatId, menu_button: { type: 'web_app', text: 'GuideFit', web_app: { url: APP_URL } } });
    return;
  }

  if (cmd === '/stop' || cmd === '/unsubscribe') {
    const ok = await disableNotifications(chatId);
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: ok
        ? 'Напоминания выключены. Включить снова — командой /start или в приложении: Настройки → Уведомления.'
        : 'Напоминания и так выключены.',
      reply_markup: openKeyboard()
    });
    return;
  }

  if (cmd === '/help') {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: 'Просто открой приложение кнопкой выше.\n\n/stop — отключить напоминания\n\nВопросы и пожелания пиши сюда — читаем всё.',
      reply_markup: openKeyboard()
    });
    return;
  }

  // обычный текст без команды: мягко направляем в приложение, но не спамим на каждое сообщение
  await tgApi('sendMessage', {
    chat_id: chatId,
    text: 'Привет! Я отвечаю только на команды. Открой приложение кнопкой ниже — там дневник питания, тренировки и вода.',
    reply_markup: openKeyboard()
  });
}

let offset = -1, backoff = 1000;
async function loop() {
  try {
    const res = await fetch('https://api.telegram.org/bot' + TOKEN + '/getUpdates?offset=' + offset + '&timeout=30', {
      signal: AbortSignal.timeout(40000)
    }).then(r => r.json()).catch(() => null);
    backoff = 1000;
    if (res && res.ok) {
      for (const u of res.result || []) {
        offset = u.update_id + 1;
        try { await handleMessage(u.message); }
        catch (e) { console.error('Bot handler error [' + randomId() + ']:', e && e.message ? e.message : e); }
      }
    } else if (res && res.description) {
      console.error('Bot API:', res.description);
    }
  } catch (e) {
    console.error('Bot poll error:', e && e.message ? e.message : e);
    backoff = Math.min(backoff * 2, 60000);
    setTimeout(loop, backoff);
    return;
  }
  setTimeout(loop, 100);
}

process.on('SIGINT', () => { console.log('Остановка бота...'); try { db.close(); } catch (e) {} process.exit(0); });
process.on('SIGTERM', () => { try { db.close(); } catch (e) {} process.exit(0); });

loop();
console.log('Бот GuideFit запущен');
