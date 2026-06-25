import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { alphaPaiProfileDir, launchAlphaPaiContext } from "./persistent-context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const config = readJson(path.join(rootDir, "config/latest-extraction.json"));
const authPath = path.join(rootDir, config.authFile || "runtime/auth.json");
const checkUrl = `${config.alphaPai.origin}/reading/paiwork`;

const context = await launchAlphaPaiContext(config, rootDir, {
  headless: process.env.HEADLESS !== "false"
});

try {
  const page = await context.newPage();
  await page.goto(checkUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1000);

  const loggedIn = !page.url().includes(config.alphaPai.loginCheckPath || "/login");
  const result = {
    authFile: authPath,
    authFileExists: fs.existsSync(authPath),
    authProfileDir: alphaPaiProfileDir(config, rootDir),
    authProfileExists: fs.existsSync(alphaPaiProfileDir(config, rootDir)),
    loggedIn,
    url: page.url(),
    title: await page.title().catch(() => "")
  };

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = loggedIn ? 0 : 2;
} finally {
  await context.close().catch(() => {});
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
