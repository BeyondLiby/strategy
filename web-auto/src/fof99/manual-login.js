import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fof99ProfileDir, launchFof99Context } from "./persistent-context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const config = readJson(path.join(rootDir, "config/fof99-net-values.json"));
const authPath = path.join(rootDir, config.authFile || "runtime/fof99-auth.json");
const profileDir = fof99ProfileDir(config, rootDir);
const startUrl = config.fof99?.startUrl || "https://mp.fof99.com/fund/all";
const origin = config.fof99?.origin || "https://mp.fof99.com";

fs.mkdirSync(path.dirname(authPath), { recursive: true });

const context = await launchFof99Context(config, rootDir, {
  headless: false,
  viewport: config.browser?.viewport || { width: 1440, height: 1200 },
  slowMo: 100
});

const page = await context.newPage();
await page.goto(startUrl, { waitUntil: "domcontentloaded" });

console.log("请在打开的 Edge 窗口中完成 fof99 登录。脚本会等待最多 5 分钟。");

const deadline = Date.now() + 5 * 60 * 1000;
let loggedIn = false;

while (Date.now() < deadline) {
  await page.waitForTimeout(1500);
  const currentUrl = page.url();
  const pageText = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");

  if (
    currentUrl.startsWith(origin) &&
    !currentUrl.includes(config.fof99?.loginCheckPath || "/login") &&
    !currentUrl.includes("/404") &&
    !/^404\b/.test(pageText.trim())
  ) {
    loggedIn = true;
    break;
  }
}

if (!loggedIn) {
  await context.close();
  throw new Error("5 分钟内没有检测到 fof99 登录成功。");
}

await page.goto(startUrl, { waitUntil: "domcontentloaded" });
await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
await page.waitForTimeout(1500);

if (page.url().includes(config.fof99?.loginCheckPath || "/login")) {
  await context.close();
  throw new Error("登录态验证失败，仍然跳转到了登录页。");
}

const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
if (page.url().includes("/404") || /^404\b/.test(bodyText.trim())) {
  await context.close();
  throw new Error(`登录态验证失败，起始页面不存在：${page.url()}`);
}

if (config.session?.storageStateBackup !== false) {
  await context.storageState({ path: authPath });
}
console.log(`Saved fof99 persistent profile to ${profileDir}`);
if (config.session?.storageStateBackup !== false) {
  console.log(`Saved fof99 auth state backup to ${authPath}`);
}
await context.close();

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
