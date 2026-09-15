/* Резервная копия базы GuideFit без остановки приложения.
   База работает в режиме WAL, поэтому копирование файла «руками» может дать
   несогласованный слепок. Здесь используется штатное средство SQLite
   VACUUM INTO — оно делает целостную копию на живой базе.

   Запуск:  npm run backup
   Параметры (env):
     DB_PATH          — путь к базе (по умолчанию ./guidefit.db)
     BACKUP_DIR       — куда складывать копии (по умолчанию ./backups)
     BACKUP_KEEP_DAYS — сколько дней хранить копии (по умолчанию 14, 0 = не удалять)

   Пример для cron (ежедневно в 4:30):
     30 4 * * * cd /root/guidefit-app && /root/.nvm/versions/node/v24.20.0/bin/node scripts/backup-db.js >> backups/backup.log 2>&1
*/
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = process.env.DB_PATH || './guidefit.db';
const BACKUP_DIR = process.env.BACKUP_DIR || './backups';
const KEEP_DAYS = process.env.BACKUP_KEEP_DAYS === undefined ? 14 : parseInt(process.env.BACKUP_KEEP_DAYS, 10) || 0;

function pad(n) { return String(n).padStart(2, '0'); }
function stamp(d) {
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}
function sqlStr(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

if (!fs.existsSync(DB_PATH)) {
  console.error('База не найдена: ' + path.resolve(DB_PATH));
  process.exit(1);
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });
const dest = path.join(BACKUP_DIR, 'guidefit-' + stamp(new Date()) + '.db');

const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
db.run('VACUUM INTO ' + sqlStr(path.resolve(dest)), (err) => {
  if (err) {
    console.error('Не удалось создать копию: ' + err.message);
    try { fs.unlinkSync(dest); } catch (e) {}
    db.close(() => process.exit(1));
    return;
  }
  const size = fs.statSync(dest).size;
  console.log('Копия создана: ' + dest + ' (' + (size / 1048576).toFixed(2) + ' МБ)');

  // удаляем копии старше KEEP_DAYS (по дате в имени файла)
  if (KEEP_DAYS > 0) {
    const limit = Date.now() - KEEP_DAYS * 86400000;
    let removed = 0;
    try {
      for (const f of fs.readdirSync(BACKUP_DIR)) {
        const m = f.match(/^guidefit-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/);
        if (!m) continue;
        const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
        if (t < limit) { fs.unlinkSync(path.join(BACKUP_DIR, f)); removed++; }
      }
    } catch (e) { console.error('Чистка копий: ' + e.message); }
    if (removed) console.log('Удалено старых копий: ' + removed + ' (старше ' + KEEP_DAYS + ' дней)');
  }
  db.close(() => process.exit(0));
});
