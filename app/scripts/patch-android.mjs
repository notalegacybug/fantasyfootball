// Run in CI after `npx cap add android`: the android/ project is generated fresh on
// every build (nothing Android-specific is committed), so our customisations are applied
// here -- the launcher icon, and the rosteroptimizer:// link the web app's "Open in the
// app" button uses.
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";

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
