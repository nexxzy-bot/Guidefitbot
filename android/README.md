# GuideFit — Android-обёртка для RuStore

WebView-обёртка приложения (без Gradle — сборка через aapt2/javac/d8/apksigner).

## Требования

- JDK 17 (`sudo apt install openjdk-17-jdk-headless`)
- Android SDK: `$ANDROID_HOME/platforms/android-34` и `$ANDROID_HOME/build-tools/34.0.0`
  (устанавливаются через `cmdline-tools/bin/sdkmanager "platforms;android-34" "build-tools;34.0.0"`)

## Сборка

```bash
bash android/build.sh              # версия берётся из package.json
bash android/build.sh 2.2.1 21     # явные versionName и versionCode
```

Результат: `android/GuideFit-v<версия>.apk` — подписанный release-APK.

### Ключ подписи

При первой сборке создаётся `android/guidefit-release.keystore` (пароль по умолчанию
`guidefit2026`, меняется переменной `GUIDEFIT_KS_PASS`). **Обязательно сохрани keystore
в надёжном месте** — без него RuStore не примет обновления приложения. Ключ не коммитится
в git (см. `.gitignore`).

## Манифест и версии

- `versionName` синхронизирован с `package.json` (сейчас 2.2.0)
- `versionCode` считается из версии: major*100 + minor*10 + patch (2.2.0 → 220)
- при каждой публикации в RuStore повышай versionCode

## Что внутри

- `MainActivity` — WebView с localStorage, cookies первого пользователя, только HTTPS
  (`network_security_config`), запрет смешанного контента, Safe Browsing.
- Внутри WebView остаются: домен приложения и VK/OK-домены (вход VK ID).
  Остальные ссылки открываются в браузере.
- Кнопка «Назад» работает внутри истории WebView.
- Иконки — из фирменного градиента (генерируются `sharp` из SVG).

## Чек-лист публикации в RuStore

1. Регистрация разработчика: https://dev.rustore.ru (для ИП — данные ИП Солдатенко Я. П.,
   ОГРНИП 325246800130330).
2. Загрузить APK в консоль RuStore.
3. Возрастной рейтинг: **12+** (соответствует ст. 6 436-ФЗ и маркировке в приложении).
4. Обязательно заполнить:
   - Политика конфиденциальности: `https://app.xn--80aag3axnld9b.xn--p1ai/privacy.html`
   - Пользовательское соглашение: `https://app.xn--80aag3axnld9b.xn--p1ai/terms.html`
   - Email поддержки: nexxzy@vk.com
5. Скриншоты: минимум 2 (телефон), рекомендуемые размеры 1080×1920.
6. Категория: «Здоровье и фитнес».
7. Описание: без медицинских обещаний («не заменяет консультацию врача» — уже в текстах).
8. После модерации RuStore может запросить видеоролик работы приложения.

## Известные ограничения WebView-обёртки

- Push-уведомления из Telegram-бота работают только пока бот открыт/установлен
  (нативный FCM/RuStore Push не подключён — отдельная задача).
- Сессия хранится в localStorage WebView — при очистке данных приложения потребуется
  повторный вход (для VK-аккаунтов — вход в один тап).
