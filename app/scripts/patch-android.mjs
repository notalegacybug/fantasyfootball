// Run in CI after `npx cap add android`: the android/ project is generated fresh on
// every build (nothing Android-specific is committed), so our customisations are applied
// here -- the launcher icon, the version number and Play upload signing, and the
// rosteroptimizer:// link the web app's "Open in the app" button uses.
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";

// Replace exactly one occurrence, or fail loudly if the Capacitor template changed.
function replaceOnce(text, find, replacement, file) {
  if (text.split(find).length !== 2) {
    throw new Error(`Expected one "${find}" in ${file} -- Capacitor template changed?`);
  }
  return text.replace(find, replacement);
}

// Version + signing. Play rejects an upload whose versionCode isn't higher than the last,
// so CI passes its run number as VERSION_CODE. Release builds are signed with the Play
// upload key only when CI provides UPLOAD_KEYSTORE (a PKCS12 file decoded from a GitHub
// secret into the runner's temp dir) and UPLOAD_PASSWORD; without them bundleRelease
// still builds, just unsigned. The alias "upload" matches `openssl pkcs12 -name upload`.
const gradlePath = "android/app/build.gradle";
let gradle = readFileSync(gradlePath, "utf8");
if (!gradle.includes("VERSION_CODE")) {
  // No space-then-paren after the property name: in Groovy `versionCode (x) as int` is
  // `versionCode(x)` cast afterwards, which fails with "value is null".
  gradle = replaceOnce(gradle, "versionCode 1",
    `versionCode Integer.parseInt(System.getenv("VERSION_CODE") ?: "1")`, gradlePath);
  gradle = replaceOnce(gradle, `versionName "1.0"`,
    `versionName("1.0." + (System.getenv("VERSION_CODE") ?: "0"))`, gradlePath);
  gradle = replaceOnce(gradle, "    buildTypes {", `    signingConfigs {
        release {
            if (System.getenv("UPLOAD_KEYSTORE")) {
                storeFile file(System.getenv("UPLOAD_KEYSTORE"))
                storeType "pkcs12"
                storePassword System.getenv("UPLOAD_PASSWORD")
                keyAlias "upload"
                keyPassword System.getenv("UPLOAD_PASSWORD")
            }
        }
    }
    buildTypes {`, gradlePath);
  gradle = replaceOnce(gradle, "        release {\n            minifyEnabled false", `        release {
            if (System.getenv("UPLOAD_KEYSTORE")) signingConfig signingConfigs.release
            minifyEnabled false`, gradlePath);
  writeFileSync(gradlePath, gradle);
  console.log("app/build.gradle: versionCode from VERSION_CODE, release upload signing");
}

// Launcher icon: same file names as Capacitor's defaults, so copying over them is enough.
// Made by scripts/make_icons.py from art/logo-source.jpg.
const RES = "android/app/src/main/res";
if (!existsSync(`${RES}/mipmap-mdpi/ic_launcher.png`)) {
  throw new Error("No default launcher icon -- Capacitor template changed?");
}
cpSync("art/android-res", RES, { recursive: true });
console.log("res/: copied RosterOptimizer launcher icons");

const path = "android/app/src/main/AndroidManifest.xml";
const xml = readFileSync(path, "utf8");
if (xml.includes('android:scheme="rosteroptimizer"')) process.exit(0);
const filter = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="rosteroptimizer" />
            </intent-filter>
        </activity>`;
const i = xml.indexOf("</activity>");
if (i < 0) throw new Error("No </activity> in AndroidManifest.xml -- Capacitor template changed?");
writeFileSync(path, xml.slice(0, i) + filter.trimStart() + xml.slice(i + "</activity>".length));
console.log("AndroidManifest.xml: added rosteroptimizer:// intent filter");
