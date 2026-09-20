/* Часовые пояса и «дни» пользователя.

   В базе все моменты времени — UTC. «День» (дневник, вода, вес, серии
   тренировок) — понятие локальное для человека, поэтому любую дату считаем
   в поясе ПОЛЬЗОВАТЕЛЯ (users.timezone), а не в поясе сервера.
   Раньше всё шло через TZ процесса (Europe/Moscow): для пользователя во
   Владивостоке «сегодня» 7 часов в сутки означало вчерашний день, и завтрак
   уезжал в чужую дату дневника. Россия тянется от UTC+2 до UTC+12.

   Модуль намеренно без зависимостей и без состояния: чистые функции, которые
   можно проверить тестами, не поднимая сервер (см. tests/tz.test.js). */

// Пояс сервера — только для служебных величин (сводка админки) и как запасной
// вариант для аккаунтов, которые ещё не выбрали свой пояс.
const APP_TZ = process.env.TZ || 'Europe/Moscow';

/** Безопасное имя пояса.
    На запись пояс ограничен только набором символов, поэтому в базе могло
    оказаться имя, которого нет в базе поясов (например «Foo/Bar»).
    Неизвестное имя не должно ронять запрос — откатываемся к UTC. */
function safeTz(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz || APP_TZ });
    return tz || APP_TZ;
  } catch (e) { return 'UTC'; }
}

/** Смещение пояса от UTC в минутах на заданный момент (по умолчанию — сейчас). */
function tzOffsetMinutes(tz, at) {
  const when = at || new Date();
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTz(tz), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(when).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day,
    p.hour === '24' ? 0 : +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - when.getTime()) / 60000);
}

/** Модификатор для SQLite: date(ts, tzModifier(tz)) переводит UTC в пояс пользователя. */
function tzModifier(tz, at) {
  const m = tzOffsetMinutes(tz, at);
  return (m >= 0 ? '+' : '-') + Math.abs(m) + ' minutes';
}

/** Дата YYYY-MM-DD в поясе tz со сдвигом на offsetDays (по умолчанию — сегодня). */
function dateIn(tz, offsetDays, at) {
  const base = at ? at.getTime() : Date.now();
  const d = new Date(base + (offsetDays || 0) * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTz(tz), year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

module.exports = { APP_TZ, safeTz, tzOffsetMinutes, tzModifier, dateIn };
