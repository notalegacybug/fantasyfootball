// Run in CI after `npx cap add ios` (the ios/ project is generated fresh each build).
// Registers the rosteroptimizer:// link scheme -- the iOS twin of patch-android.mjs.
import { readFileSync, writeFileSync } from "node:fs";

const path = "ios/App/App/Info.plist";
const plist = readFileSync(path, "utf8");
if (plist.includes("<string>rosteroptimizer</string>")) process.exit(0);
const entry = `	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleURLName</key>
			<string>com.notalegacybug.rosteroptimizer</string>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>rosteroptimizer</string>
			</array>
		</dict>
	</array>
</dict>
</plist>`;
const i = plist.lastIndexOf("</dict>");
if (i < 0) throw new Error("Unexpected Info.plist shape -- Capacitor template changed?");
writeFileSync(path, plist.slice(0, i) + entry + "\n");
console.log("Info.plist: added rosteroptimizer:// URL scheme");
