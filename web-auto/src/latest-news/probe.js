import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchAlphaPaiContext } from "../auth/persistent-context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const config = readJson(path.join(rootDir, "config/latest-extraction.json"));
const args = parseArgs(process.argv.slice(2));
const stock = {
  code: args.code || "NVO.US",
  name: args.name || "诺和诺德公司",
  url: args.url || ""
};

const outputDir = path.join(rootDir, "output", "debug");
const headless = process.env.HEADLESS !== "false";
fs.mkdirSync(outputDir, { recursive: true });

const context = await launchAlphaPaiContext(config, rootDir, { headless });

try {
  const page = await context.newPage();
  await page.goto(stock.url || stockUrlFromCode(stock), { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1500);

  if (page.url().includes(config.alphaPai.loginCheckPath || "/login")) {
    if (headless) {
      const message = [
        "Probe stopped because Alpha Pai redirected to the login page.",
        "runtime/auth.json exists, but the saved session is not currently valid.",
        "Run: npm run login:check",
        "Then refresh auth with: npm run login",
        "Or debug interactively with: $env:HEADLESS='false'; npm run probe -- --code ... --name ..."
      ].join("\n");
      throw new Error(message);
    }

    await waitForInteractiveLogin(page, stock.url || stockUrlFromCode(stock));
  }

  const baseName = safeName(`${stock.code}_${stock.name}`);
  await page.screenshot({ path: path.join(outputDir, `${baseName}.png`), fullPage: true });

  const data = await page.evaluate((payload) => {
    const { selectors, typeNames } = payload;
    const list = [...document.querySelectorAll(selectors.candidateLists)]
      .map((element) => element.__vue__?._data?.list)
      .find((items) => Array.isArray(items) && items.length) || [];

    return {
      url: location.href,
      title: document.title,
      candidates: list.slice(0, 50).map((item, index) => ({
        index,
        id: item.id,
        type: item.type,
        typeName: typeNames?.[String(item.type)] || "未知",
        time: item.time,
        dateText: item.dateText,
        title: item.title,
        institutionText: item.institutionText,
        hasCommentCn: Boolean(item.commentCn),
        hasCommentEn: Boolean(item.commentEn),
        pdfFlag: item.pdfFlag,
        icon: item.icon
      }))
    };
  }, {
    selectors: config.selectors,
    typeNames: config.candidateRules?.typeNames || {}
  });

  const jsonPath = path.join(outputDir, `${baseName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), "utf8");
  console.log(jsonPath);
} finally {
  await context.close().catch(() => {});
}

function stockUrlFromCode(stock) {
  return `${config.alphaPai.origin}${config.alphaPai.stockPath}?id=${encodeURIComponent(stock.code)}&name=${encodeURIComponent(stock.name)}`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    result[arg.slice(2)] = args[index + 1] || "";
    index += 1;
  }
  return result;
}

function safeName(value) {
  return String(value || "untitled")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 120)
    .trim();
}

async function waitForInteractiveLogin(page, returnUrl) {
  console.log("Detected login page. Please log in in the opened Edge window. Waiting up to 5 minutes...");
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    if (!page.url().includes(config.alphaPai.loginCheckPath || "/login")) {
      await page.goto(returnUrl, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(1000);
      return;
    }
  }
  throw new Error("Login was not detected within 5 minutes.");
}
