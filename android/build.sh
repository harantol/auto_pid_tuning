#!/bin/sh
# Builds the Android APK without Gradle: aapt2 (resources), javac + d8 (code), zipalign and
# apksigner, from an installed Android SDK (GitHub runners have one in $ANDROID_HOME). The web
# app (app/) goes in the APK as assets: the analysis runs on the phone.
#
#   sh android/build.sh               # -> android/build/auto-pid-tuning-<version>.apk
#
# Variables:
#   APP_VERSION        version name, MAJOR.MINOR (default: src/auto_pid_tuning/version.py)
#   ANDROID_KEYSTORE   signing key; every release must use the same one, or Android refuses
#   ANDROID_KEYSTORE_PASSWORD   the update. Without a key, a throwaway one is made (CI checks).
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$HERE")
: "${ANDROID_HOME:?set ANDROID_HOME to an Android SDK}"
BT=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -n 1)
PLATFORM=$(ls -d "$ANDROID_HOME"/platforms/android-* | sort -V | tail -n 1)/android.jar
OUT=$HERE/build
VERSION=${APP_VERSION:-$(python3 "$ROOT/src/auto_pid_tuning/version.py")}
CODE=$((${VERSION%.*} * 1000 + ${VERSION#*.})) # 1.6 -> 1006: grows with every version
APK=$OUT/auto-pid-tuning-$VERSION.apk

rm -rf "$OUT"
mkdir -p "$OUT/assets" "$OUT/classes" "$OUT/dex"
cp -R "$ROOT/app" "$OUT/assets/app"
printf '{"version": "%s"}\n' "$VERSION" > "$OUT/assets/app/version.json"

"$BT/aapt2" compile --dir "$HERE/res" -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/unsigned.apk" -I "$PLATFORM" --manifest "$HERE/AndroidManifest.xml" \
  --min-sdk-version 29 --target-sdk-version 34 --version-code "$CODE" --version-name "$VERSION" \
  -A "$OUT/assets" "$OUT/res.zip"

javac -nowarn -encoding UTF-8 --release 11 -classpath "$PLATFORM" -d "$OUT/classes" $(find "$HERE/src" -name '*.java')
"$BT/d8" --release --lib "$PLATFORM" --min-api 29 --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
(cd "$OUT/dex" && zip -q "$OUT/unsigned.apk" classes.dex)

KEYSTORE=${ANDROID_KEYSTORE:-$OUT/throwaway.keystore}
PASS=${ANDROID_KEYSTORE_PASSWORD:-throwaway}
if [ ! -f "$KEYSTORE" ]; then
  echo "No signing key: signing with a throwaway one (not for release)" >&2
  keytool -genkeypair -keystore "$KEYSTORE" -storepass "$PASS" -keypass "$PASS" -alias auto-pid-tuning \
    -keyalg RSA -keysize 2048 -validity 36500 -dname "CN=Betaflight auto-tune" > /dev/null
fi
"$BT/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass "pass:$PASS" --key-pass "pass:$PASS" \
  --ks-key-alias auto-pid-tuning --out "$APK" "$OUT/aligned.apk"
"$BT/apksigner" verify "$APK"
rm -f "$OUT/unsigned.apk" "$OUT/aligned.apk" "$OUT"/*.idsig "$OUT/throwaway.keystore"
echo "$APK"
