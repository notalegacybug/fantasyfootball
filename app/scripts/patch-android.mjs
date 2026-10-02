// Run in CI after `npx cap add android`: the android/ project is generated fresh on
// every build (nothing Android-specific is committed), so our one customisation is
// applied here -- the ffweekly:// link the web app's "Open in the app" button uses.
import { readFileSync, writeFileSync } from "node:fs";

const path = "android/app/src/main/AndroidManifest.xml";
const xml = readFileSync(path, "utf8");
if (xml.includes('android:scheme="ffweekly"')) process.exit(0);
const filter = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="ffweekly" />
            </intent-filter>
        </activity>`;
const i = xml.indexOf("</activity>");
if (i < 0) throw new Error("No </activity> in AndroidManifest.xml -- Capacitor template changed?");
writeFileSync(path, xml.slice(0, i) + filter.trimStart() + xml.slice(i + "</activity>".length));
console.log("AndroidManifest.xml: added ffweekly:// intent filter");
