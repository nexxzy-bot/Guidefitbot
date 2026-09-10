# GuideFit

Telegram Mini App: нормы калорий/БЖУ/воды, блюда под цель, дневник питания, программы тренировок с логом подходов и таймером.

## Стек
Node.js >= 18, Express, SQLite. Фронтенд — один файл static/index.html без фреймворков. tg_id из Telegram initData, валидация HMAC на сервере.

## Файлы
- server.js — API, нормы, достижения, уведомления через Telegram Bot API
- db.js — схема SQLite, индексы, сидирование
- static/index.html — фронтенд
- static/manifest.webmanifest, static/sw.js — PWA
- scripts/preheat-images.js — прогрев фото из Pexels (200/час)
- scripts/generate-dishes.js — генерация блюд через Gemini

## .env
- MINIAPP_PORT — порт (default 3000)
- TELEGRAM_TOKEN — токен бота: валидация initData + уведомления
- PEXELS_API_KEY — фото блюд
- GEMINI_API_KEY — генерация блюд

## Деплой
npm install && cp .env.example .env && npm start
(или pm2 start server.js --name guidefit)

## Полезное
npm run preheat — докачать фото (можно повторно)
npm run generate — новые блюда через Gemini
