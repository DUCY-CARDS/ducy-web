# The Android app (test build)

A Capacitor shell that opens https://ducy.cards full screen, built by
`.github/workflows/android.yml` into a debug APK (an artifact of the run).

- `capacitor.config.json`: the app's id (`cards.ducy.app`), name, and the
  site it opens.
- `www/`: what shows when the site can't be reached.

The Android project itself (`android/`) is generated in the workflow with
`npx cap add android`, so nothing generated is committed. To build locally
you need Node, JDK 21 and the Android SDK:

```sh
cd app
npm install @capacitor/core@7 @capacitor/cli@7 @capacitor/android@7
npx cap add android
cd android && ./gradlew assembleDebug   # app/build/outputs/apk/debug/app-debug.apk
```

The debug APK is signed with a throwaway debug key: fine to sideload for
testing, not for the Play Store.
