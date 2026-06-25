import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { alphaPaiProfileDir, launchAlphaPaiContext } from "./persistent-context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const config = readJson(path.join(rootDir, "config/latest-extraction.json"));
const authPath = path.join(rootDir, config.authFile || "runtime/auth.json");
const startUrl = `${config.alphaPai?.origin || "https://alphapai-web.rabyte.cn"}/reading/paiwork`;

fs.mkdirSync(path.dirname(authPath), { recursive: true });

const context = await launchAlphaPaiContext(config, rootDir, {
  headless: false,
  viewport: { width: 1440, height: 1000 },
  slowMo: 100
});

const page = await context.newPage();
await page.goto(startUrl, { waitUntil: "domcontentloaded" });

console.log("Please complete login in the opened Edge window. Waiting up to 5 minutes...");

const deadline = Date.now() + 5 * 60 * 1000;
let loggedIn = false;

while (Date.now() < deadline) {
  await page.waitForTimeout(1500);
  const currentUrl = page.url();

  if (!currentUrl.includes("/login") && currentUrl.startsWith("https://alphapai-web.rabyte.cn/")) {
    loggedIn = true;
    break;
  }
}

if (!loggedIn) {
  await context.close();
  throw new Error("Login was not detected within 5 minutes.");
}

await page.goto(startUrl, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
if (page.url().includes("/login")) {
  await context.close();
  throw new Error("Login state did not pass verification; still redirected to /login.");
}

await context.storageState({ path: authPath });
console.log(`Saved persistent login profile to ${alphaPaiProfileDir(config, rootDir)}`);
console.log(`Saved compatibility auth state to ${authPath}`);
await context.close();

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
