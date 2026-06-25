import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { alphaPaiProfileDir, launchAlphaPaiContext } from "./persistent-context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const config = readJson(path.join(rootDir, "config/latest-extraction.json"));
const authPath = path.join(rootDir, config.authFile || "runtime/auth.json");
const phone = process.env.ALPHA_PHONE;
const password = process.env.ALPHA_PASSWORD;
const startUrl = `${config.alphaPai?.origin || "https://alphapai-web.rabyte.cn"}/reading/paiwork`;
const debugDir = path.join(rootDir, "output", "debug");

if (!phone || !password) {
  throw new Error("Missing ALPHA_PHONE or ALPHA_PASSWORD environment variable.");
}

fs.mkdirSync(path.dirname(authPath), { recursive: true });
fs.mkdirSync(debugDir, { recursive: true });

const context = await launchAlphaPaiContext(config, rootDir, {
  headless: false,
  viewport: { width: 1440, height: 1000 },
  slowMo: 100
});

const page = await context.newPage();
await page.goto(startUrl, { waitUntil: "domcontentloaded" });
await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

if (page.url().includes("/login")) {
  await page.getByText("账号密码登录").click({ timeout: 10_000 }).catch(() => {});

  const inputs = page.locator("input");
  const count = await inputs.count();
  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    const placeholder = await input.getAttribute("placeholder").catch(() => "");
    const type = await input.getAttribute("type").catch(() => "");
    if (/手机|账号|用户名/.test(placeholder || "")) {
      await input.fill(phone);
    } else if ((placeholder || "").includes("密码") || type === "password") {
      await input.fill(password);
    }
  }

  let loginButton = page.locator("button:has-text('登录')").last();
  if (!(await loginButton.count())) {
    loginButton = page.getByText("登录").last();
  }
  await Promise.all([
    page.waitForURL((url) => !url.href.includes("/login"), { timeout: 30_000 }).catch(() => {}),
    loginButton.click()
  ]);
}

await page.waitForTimeout(2000);
if (page.url().includes("/login")) {
  await page.screenshot({ path: path.join(debugDir, "auto-login-failed.png"), fullPage: true }).catch(() => {});
  await context.close();
  throw new Error("Login did not complete. The site may require SMS verification or another interactive step.");
}

await context.storageState({ path: authPath });
console.log(`Saved persistent login profile to ${alphaPaiProfileDir(config, rootDir)}`);
console.log(`Saved compatibility auth state to ${authPath}`);
await context.close();

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
