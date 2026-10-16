# Android app

The web app served by S13, in a WebView: install it from the home F-Droid store
(http://192.168.1.15:8480) or from the APK attached to a GitHub release. The analysis runs on
S13, so the app only works on the home WiFi; elsewhere it shows a page saying so, with a retry
button. Android 10 or later.

`src/home/autopidtuning/MainActivity.java` is the whole app: it opens S13, sends links to other
sites to the browser, lets the page pick a log from the phone, and gives the page
`window.AutoPidAndroid.copy()` and `.save()`, because a plain HTTP page in a WebView has no
clipboard API and no downloads (`web/static/app.js` uses them when they exist).

## Build

No Gradle: `build.sh` calls `aapt2`, `javac`, `d8`, `zipalign` and `apksigner` from an
installed Android SDK (`ANDROID_HOME`) and a JDK 17.

```bash
sh android/build.sh    # -> android/build/auto-pid-tuning-<version>.apk
```

The version is the app's `MAJOR.MINOR` (`version.py`); the Android version code is
`MAJOR * 1000 + MINOR`. `APP_SERVER` changes the address it opens.

Each PR builds it with a throwaway key (CI artifact `apk`). Each merge into `master` builds it
with the release key and attaches it to the GitHub release `vX.Y`, where the store finds it.
The listing in the store (name, descriptions, icon) is `fastlane/metadata/android/fr-FR/`.

## The signing key

Android only installs an update signed with the same key as the installed app. The key is the
`ANDROID_KEYSTORE_BASE64` and `ANDROID_KEYSTORE_PASSWORD` secrets of the GitHub repo; the
original is on S13 in `~/auto_pid_tuning/android-signing/`. **If it is lost**, new versions no
longer install over the old one: the app must be uninstalled first (nothing is lost, it keeps
no data).
