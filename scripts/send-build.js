/* GuideFit — доставка собранного APK в Telegram владельцу.

   Приложение Telegram больше не использует: этот скрипт нужен только для того,
   чтобы после сборки получить файл в личный чат с ботом.

   Запуск:
     npm run send-build                 # возьмёт свежий android/GuideFit-v*.apk
     npm run send-build -- path/to.apk  # отправит указанный файл

   В .env нужны:
     TELEGRAM_TOKEN — токен бота (@BotFather)
     BUILD_CHAT_ID  — куда отправлять (ваш chat_id из @userinfobot);
                      если не задан, используется ADMIN_ID.
*/
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const token = String(process.env.TELEGRAM_TOKEN || '').trim();
const chatId = String(process.env.BUILD_CHAT_ID || process.env.ADMIN_ID || '').trim();

if (!token) { console.error('Нет TELEGRAM_TOKEN в .env — отправлять нечем.'); process.exit(1); }
if (!chatId) { console.error('Нет BUILD_CHAT_ID (или ADMIN_ID) в .env — не знаю, куда отправлять.'); process.exit(1); }

// Какой файл отправляем: аргумент командной строки или самый свежий APK в android/
function pickApk() {
  const arg = process.argv[2];
  if (arg) {
    const p = path.isAbsolute(arg) ? arg : path.join(ROOT, arg);
    if (!fs.existsSync(p)) { console.error('Файл не найден: ' + p); process.exit(1); }
    return p;
  }
  const dir = path.join(ROOT, 'android');
  const version = require(path.join(ROOT, 'package.json')).version;
  const exact = path.join(dir, 'GuideFit-v' + version + '.apk');
  if (fs.existsSync(exact)) return exact;
  // фолбэк: самый новый *.apk в android/ (и .idsig игнорируем)
  const apks = fs.readdirSync(dir)
    .filter(f => /^GuideFit-v\d+\.\d+\.\d+\.apk$/.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!apks.length) { console.error('В android/ нет ни одной сборки GuideFit-vX.Y.Z.apk — сначала соберите: bash android/build.sh'); process.exit(1); }
  return path.join(dir, apks[0].f);
}

async function send(apkPath, attempt = 1) {
  const buf = fs.readFileSync(apkPath);
  const name = path.basename(apkPath);
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', 'GuideFit — сборка ' + name + ' (' + (buf.length / 1048576).toFixed(1) + ' МБ)');
  form.append('document', new Blob([buf], { type: 'application/vnd.android.package-archive' }), name);

  const res = await fetch('https://api.telegram.org/bot' + token + '/sendDocument', {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120000)
  });
  const data = await res.json().catch(() => null);
  if (res.ok && data && data.ok) return true;
  const reason = (data && data.description) || ('HTTP ' + res.status);
  if (attempt < 3) {
    console.error('Отправка не удалась (' + reason + '), повтор через ' + attempt * 3 + ' с…');
    await new Promise(r => setTimeout(r, attempt * 3000));
    return send(apkPath, attempt + 1);
  }
  console.error('Telegram отказал: ' + reason);
  return false;
}

(async () => {
  const apkPath = pickApk();
  console.log('Отправляю ' + path.basename(apkPath) + ' в чат ' + chatId + '…');
  const ok = await send(apkPath);
  if (!ok) process.exit(1);
  console.log('Готово: файл отправлен в Telegram.');
})();
