# GuideFit

Приложение для питания и тренировок: нормы калорий/БЖУ/воды, рецепты под цель,
дневник питания, вода, вес, программы тренировок с логом подходов, практики йоги,
достижения и напоминания.

Работает в двух режимах:

- **Telegram Mini App** — вход по подписанным `initData` (HMAC-проверка на сервере).
- **Standalone / APK (RuStore)** — вход через **VK ID** или **анонимная регистрация**
  без номера телефона. Сессия хранится в `localStorage` (`x-session-token`).

## Стек

Node.js >= 18, Express 4, SQLite (`sqlite3`), Telegram Bot API.
Фронтенд — **один файл** `static/index.html` без фреймворков и сборки
(конвенция проекта: вся вёрстка, стили и логика в одном файле).

## Файлы

| Файл | Назначение |
|---|---|
| `server.js` | API, расчёты норм, достижения, сессии, напоминания, админка, CSP |
| `db.js` | схема SQLite, индексы, каталоги из JSON (пересев только при изменении файла) |
| `bot.js` | Telegram-бот: кнопка Mini App, привязка чата, `/stop`, `/help` |
| `static/index.html` | весь фронтенд |
| `static/fonts.css`, `static/fonts/` | локальные шрифты (без Google Fonts) |
| `static/sw.js`, `static/manifest.webmanifest` | PWA: офлайн-режим, установка |
| `static/privacy.html`, `static/terms.html` | политика обработки ПДн и пользовательское соглашение |
| `static/admin.html` | админка (`ADMIN_TOKEN`) |
| `scripts/backup-db.js` | резервная копия базы (`VACUUM INTO`) с ротацией |
| `scripts/preheat-images.js` | прогрев фото блюд (Pexels → WebP) |
| `scripts/generate-dishes.js` | генерация блюд через Gemini |
| `tests/api.test.js` | smoke-тесты API на отдельной временной базе |
| `deploy/nginx-guidefit-app.conf` | эталон конфига nginx (проброс реального IP и т.д.) |

## Запуск

```bash
npm install
cp .env.example .env     # заполнить переменные
npm start                # сервер
npm run bot              # Telegram-бот (отдельный процесс)
```

В продакшене оба процесса держит pm2:

```bash
pm2 start server.js --name guidefit-app
pm2 start bot.js   --name guidefit-bot
pm2 save
```

## Проверки и обслуживание

```bash
npm run check    # синтаксис всех серверных файлов и service worker
npm test         # smoke-тесты API (12 тестов, отдельная база)
npm run backup   # резервная копия базы (VACUUM INTO, ротация 14 дней)
```

Крон для ежедневного бэкапа:

```cron
30 4 * * * cd /root/guidefit-app && /root/.nvm/versions/node/v24.20.0/bin/node scripts/backup-db.js >> backups/backup.log 2>&1
```

## Переменные окружения

Все секреты — только в `.env` (в репозиторий не попадает). Полный список с
комментариями — в `.env.example`.

Ключевые: `MINIAPP_PORT`, `MINIAPP_URL`, `TELEGRAM_TOKEN`, `TELEGRAM_USERNAME`,
`ADMIN_TOKEN`, `VK_CLIENT_ID`, `VK_CLIENT_SECRET`, `TZ` (по умолчанию `Europe/Moscow`).

## API (основное)

- `POST /api/auth/anonymous` — анонимная регистрация (rate-limit 10 аккаунтов/час на IP)
- `POST /api/auth/vk/exchange` — обмен кода VK ID на сессию (имя из VK не подставляется)
- `GET /api/auth/me` — кто я по текущей сессии
- `POST /api/user/init` — завершение визарда (возраст 12–100)
- `GET /api/user/export` — выгрузка всех своих данных (право на доступ, 152-ФЗ)
- `POST /api/user/link/telegram` — одноразовый код привязки чата для напоминаний
- `POST /api/user/delete` — удаление аккаунта вместе с сессиями
- `GET /api/health` — статус + проверка базы + версия

## Безопасность и приватность

- CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.
  Фреймы запрещены везде, кроме Telegram Web (Mini App открывается в iframe).
- `app.set('trust proxy', 1)` + заголовки `X-Real-IP`/`X-Forwarded-For` в nginx:
  без этого все лимиты считались бы по одному IP прокси.
- Шрифты хостятся локально: IP пользователя не уходит в Google.
- Сторонняя аналитика VK ID SDK (Top.Mail.ru) заблокирована политикой CSP.
- Сессии живут 180 дней, удаляются вместе с аккаунтом и чистятся фоновым заданием.
- Напоминания уходят только в Telegram-чат: у аккаунтов ВК/анонимных — только
  после явной привязки бота.

## Соответствие требованиям РФ

- Политика обработки персональных данных и Пользовательское соглашение —
  внутри приложения (`/privacy.html`, `/terms.html`), ссылки есть на экране входа,
  в визарде и в настройках.
- Явное согласие на обработку ПДн перед созданием профиля, отметка «18+ /
  с согласия законного представителя» и возрастной порог 12 лет.
- Дисклеймер: приложение не медицинское изделие и не заменяет врача.
- Отсутствуют: реклама, сторонние трекеры, передача данных третьим лицам.
- Оператор: ИП Солдатенко Ярослав Павлович (ОГРНИП 325246800130330).

## Деплой

```bash
git push origin main          # на сервере: git pull
pm2 restart guidefit-app guidefit-bot --update-env
curl -s localhost:3000/api/health
```

При изменении `static/index.html` версия кэша в `static/sw.js` увеличивается —
иначе PWA отдаст старую версию из кэша.
