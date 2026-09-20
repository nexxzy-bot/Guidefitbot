/* Часовые пояса: граница суток и разные пояса.

   Раньше всё время в приложении считалось по поясу СЕРВЕРА (Europe/Moscow).
   Для пользователя восточнее Москвы «сегодня» несколько часов в сутки означало
   вчерашний день, и записи дневника попадали в чужую дату.
   Тесты гоняются на фиксированных моментах времени — без них такой баг
   не поймать, потому что «сейчас» всегда попадает в один и тот же день. */
const test = require('node:test');
const assert = require('node:assert');
const sqlite3 = require('sqlite3');
const { safeTz, tzOffsetMinutes, tzModifier, dateIn } = require('../time');

/* 2026-09-20 18:00 UTC — в Москве ещё 21:00 того же дня, а во Владивостоке
   уже 04:00 СЛЕДУЮЩЕГО. Именно в такие часы старый код уводил запись на день назад. */
const BOUNDARY = new Date('2026-09-20T18:00:00Z');

test('смещения поясов России считаются верно', () => {
  assert.strictEqual(tzOffsetMinutes('Europe/Kaliningrad', BOUNDARY), 120);
  assert.strictEqual(tzOffsetMinutes('Europe/Moscow', BOUNDARY), 180);
  assert.strictEqual(tzOffsetMinutes('Asia/Yekaterinburg', BOUNDARY), 300);
  assert.strictEqual(tzOffsetMinutes('Asia/Novosibirsk', BOUNDARY), 420);
  assert.strictEqual(tzOffsetMinutes('Asia/Vladivostok', BOUNDARY), 600);
  assert.strictEqual(tzOffsetMinutes('Asia/Kamchatka', BOUNDARY), 720);
});

test('граница суток: Москва и Владивосток попадают в разные дни', () => {
  assert.strictEqual(dateIn('Europe/Moscow', 0, BOUNDARY), '2026-09-20');
  assert.strictEqual(dateIn('Asia/Vladivostok', 0, BOUNDARY), '2026-09-21');
  assert.notStrictEqual(
    dateIn('Europe/Moscow', 0, BOUNDARY),
    dateIn('Asia/Vladivostok', 0, BOUNDARY),
    'в этот момент пользователи двух поясов живут в разных датах — на этом и ломался дневник'
  );
});

test('восточные пояса переходят на новый день раньше Москвы', () => {
  // 2026-09-20 12:00 UTC: в Москве 15:00 того же дня, на Камчатке уже полночь 21-го
  const noon = new Date('2026-09-20T12:00:00Z');
  assert.strictEqual(dateIn('Europe/Moscow', 0, noon), '2026-09-20');
  assert.strictEqual(dateIn('Asia/Novosibirsk', 0, noon), '2026-09-20'); // +7 — ещё 19:00
  assert.strictEqual(dateIn('Asia/Kamchatka', 0, noon), '2026-09-21'); // +12 — уже 21-е
  assert.notStrictEqual(
    dateIn('Europe/Moscow', 0, noon),
    dateIn('Asia/Kamchatka', 0, noon)
  );
});

test('dateIn: сдвиг на дни сохраняет пояс и переходит через месяц', () => {
  assert.strictEqual(dateIn('Europe/Moscow', 0, BOUNDARY), '2026-09-20');
  assert.strictEqual(dateIn('Europe/Moscow', -1, BOUNDARY), '2026-09-19');
  assert.strictEqual(dateIn('Europe/Moscow', -7, BOUNDARY), '2026-09-13');
  // 21 сентября минус 30 суток = 22 августа
  const sep21 = new Date('2026-09-21T10:00:00Z');
  assert.strictEqual(dateIn('Europe/Moscow', -30, sep21), '2026-08-22');
});

test('tzModifier даёт корректный модификатор SQLite', () => {
  assert.strictEqual(tzModifier('Europe/Moscow', BOUNDARY), '+180 minutes');
  assert.strictEqual(tzModifier('Asia/Vladivostok', BOUNDARY), '+600 minutes');
  assert.match(tzModifier('UTC', BOUNDARY), /^\+0 minutes$/);
});

test('SQLite date(ts, tzModifier) совпадает с dateIn — фильтр и запись договариваются', async () => {
  const db = new sqlite3.Database(':memory:');
  const all = (sql, args) => new Promise((res, rej) => db.all(sql, args, (e, r) => e ? rej(e) : res(r)));
  await new Promise(r => db.run('CREATE TABLE food_logs (timestamp DATETIME)', r));
  // момент записан в UTC — ровно так, как теперь пишет /api/log-meal
  await new Promise(r => db.run("INSERT INTO food_logs VALUES ('2026-09-20 18:00:00')", r));

  for (const tz of ['Europe/Moscow', 'Asia/Yekaterinburg', 'Asia/Vladivostok', 'Asia/Kamchatka']) {
    const [{ d }] = await all('SELECT date(timestamp, ?) AS d FROM food_logs', [tzModifier(tz, BOUNDARY)]);
    const expected = dateIn(tz, 0, BOUNDARY);
    assert.strictEqual(d, expected,
      `пояс ${tz}: SQL-фильтр (${d}) должен совпадать с днём пользователя (${expected})`);
  }
  db.close();
});

test('неизвестный пояс не роняет запрос, а откатывается к UTC', () => {
  // на запись пояс ограничен только набором символов, поэтому в базе могло
  // оказаться имя, которого нет в базе поясов
  assert.strictEqual(safeTz('Foo/Bar'), 'UTC');
  assert.strictEqual(safeTz(''), 'Europe/Moscow');
  assert.strictEqual(safeTz('Asia/Vladivostok'), 'Asia/Vladivostok');
  assert.strictEqual(tzOffsetMinutes('Foo/Bar', BOUNDARY), 0);
  assert.strictEqual(dateIn('Foo/Bar', 0, BOUNDARY), '2026-09-20'); // 18:00 UTC — тот же день
});
