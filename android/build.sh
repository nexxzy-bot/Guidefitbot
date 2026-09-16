#!/usr/bin/env bash
# Сборка signed APK GuideFit без Gradle (javac + d8 + aapt2 + apksigner).
# Требования: ANDROID_HOME с platforms;android-34 и build-tools;34.0.0, JDK 17.
# Использование: bash android/build.sh [versionName] [versionCode]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="${ANDROID_HOME:-/opt/android-sdk}"
BT="$SDK/build-tools/34.0.0"
PLAT="$SDK/platforms/android-34/android.jar"
SRC="$ROOT/android/app/src/main"
OUT="$ROOT/android/build"
KEYSTORE="${GUIDEFIT_KEYSTORE:-$ROOT/android/guidefit-release.keystore}"

VERSION_NAME="${1:-$(node -p "require('$ROOT/package.json').version")}"
VERSION_CODE="${2:-$(node -p "parseInt(require('$ROOT/package.json').version.split('.')[0])*100 + parseInt(require('$ROOT/package.json').version.split('.')[1])*10 + parseInt(require('$ROOT/package.json').version.split('.')[2]||'0')")}"
PACKAGE="ru.guidefit.app"

echo "==> GuideFit APK v$VERSION_NAME (code $VERSION_CODE)"

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/obj" "$OUT/apk"

# 1. Ресурсы + манифест (versionCode/versionName задаём сразу через aapt)
"$BT/aapt" package -f \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  -M "$SRC/AndroidManifest.xml" -S "$SRC/res" -I "$PLAT" \
  -J "$OUT/gen" -F "$OUT/apk/base.apk" \
  --rename-manifest-package "$PACKAGE" --auto-add-overlay

# 2. Java → dex (R.java ложится в корень gen, пакет задаётся внутри файла)
R_JAVA="$OUT/gen/R.java"
ls "$R_JAVA" >/dev/null
javac -source 17 -target 17 \
  -classpath "$PLAT" \
  -d "$OUT/obj" \
  "$R_JAVA" \
  "$SRC/java/ru/guidefit/app/MainActivity.java"
"$BT/d8" --release --lib "$PLAT" \
  --output "$OUT/apk" \
  $(find "$OUT/obj" -name '*.class')

# 3. dex в APK
cd "$OUT/apk"
"$BT/aapt" add base.apk classes.dex >/dev/null

# 4. Выравнивание
"$BT/zipalign" -f 4 base.apk aligned.apk

# 5. Подпись (release-ключ создаётся при первом запуске)
if [ ! -f "$KEYSTORE" ]; then
  echo "==> Создаю release-ключ $KEYSTORE (храните его и пароль!)"
  keytool -genkeypair -keystore "$KEYSTORE" -alias guidefit \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "${GUIDEFIT_KS_PASS:-guidefit2026}" \
    -keypass "${GUIDEFIT_KS_PASS:-guidefit2026}" \
    -dname "CN=GuideFit, OU=Mobile, O=IP Soldatenko, L=Moscow, C=RU"
fi
"$BT/apksigner" sign \
  --ks "$KEYSTORE" --ks-key-alias guidefit \
  --ks-pass pass:"${GUIDEFIT_KS_PASS:-guidefit2026}" \
  --out "$ROOT/android/GuideFit-v$VERSION_NAME.apk" \
  aligned.apk

echo "==> Готово: android/GuideFit-v$VERSION_NAME.apk"
"$BT/apksigner" verify --print-certs "$ROOT/android/GuideFit-v$VERSION_NAME.apk" | head -5
