import fs from "node:fs";
import path from "node:path";

let activeLoginRecovery = null;

export async function ensureAlphaPaiLoggedIn(page, config, rootDir, options = {}) {
  if (!isLoginUrl(page.url(), config)) return false;

  if (!activeLoginRecovery) {
    activeLoginRecovery = recoverLogin(page, config, rootDir, options)
      .finally(() => {
        activeLoginRecovery = null;
      });
  } else {
    console.log("Another worker is refreshing AlphaPai login state; waiting...");
  }

  await activeLoginRecovery;

  if (options.returnUrl) {
    await page.goto(options.returnUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  }

  if (isLoginUrl(page.url(), config)) {
    throw new Error("AlphaPai login recovery finished, but this page is still on /login.");
  }

  return true;
}

export function isLoginUrl(url, config) {
  return String(url || "").includes(config.alphaPai?.loginCheckPath || "/login");
}

async function recoverLogin(page, config, rootDir, options) {
  const credentials = readCredentials(config, rootDir);
  if (credentials.phone && credentials.password) {
    console.log("AlphaPai login expired; attempting automatic login with saved credentials...");
    await autoLogin(page, credentials, config, rootDir);
    return;
  }

  if (options.headless) {
    throw new Error(
      "AlphaPai login expired and no credentials were found. Set ALPHA_PHONE/ALPHA_PASSWORD, " +
      "or create runtime/alphapai-credentials.json, or run HEADLESS=false npm.cmd run daily for interactive login."
    );
  }

  await waitForInteractiveLogin(page, options.returnUrl);
  await saveStorageState(page, config, rootDir);
}

async function autoLogin(page, credentials, config, rootDir) {
  await choosePasswordLogin(page);
  await fillCredentials(page, credentials);
  await clickLoginButton(page);
  await page.waitForTimeout(2000);

  if (isLoginUrl(page.url(), config)) {
    await page.waitForURL((url) => !isLoginUrl(url.href, config), { timeout: 30_000 }).catch(() => {});
  }

  if (isLoginUrl(page.url(), config)) {
    const debugDir = path.join(rootDir, "output", "debug");
    fs.mkdirSync(debugDir, { recursive: true });
    await page.screenshot({ path: path.join(debugDir, "auto-login-failed.png"), fullPage: true }).catch(() => {});
    throw new Error("Automatic AlphaPai login did not complete. The site may require SMS, captcha, or another interactive step.");
  }

  await saveStorageState(page, config, rootDir);
}

async function choosePasswordLogin(page) {
  const candidates = [
    "text=账号密码登录",
    "text=密码登录",
    "text=帐号密码登录"
  ];

  for (const selector of candidates) {
    const target = page.locator(selector).first();
    if (await target.count().catch(() => 0)) {
      await target.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
      return;
    }
  }
}

async function fillCredentials(page, credentials) {
  const inputs = page.locator("input");
  const count = await inputs.count();
  let passwordFilled = false;
  let accountFilled = false;

  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    if (!(await input.isVisible().catch(() => false))) continue;

    const type = (await input.getAttribute("type").catch(() => "")) || "";
    const placeholder = (await input.getAttribute("placeholder").catch(() => "")) || "";
    const name = (await input.getAttribute("name").catch(() => "")) || "";
    const label = `${placeholder} ${name}`.toLowerCase();

    if (!passwordFilled && (type === "password" || /密码|password/.test(label))) {
      await input.fill(credentials.password);
      passwordFilled = true;
      continue;
    }

    if (!accountFilled && (type === "" || type === "tel" || type === "text" || /手机|账号|帐号|用户|phone|mobile|account|user/.test(label))) {
      await input.fill(credentials.phone);
      accountFilled = true;
    }
  }

  if (!accountFilled || !passwordFilled) {
    throw new Error("Could not find AlphaPai account/password inputs on login page.");
  }
}

async function clickLoginButton(page) {
  const candidates = [
    "button:has-text('登录')",
    "text=登录",
    "button[type='submit']"
  ];

  for (const selector of candidates) {
    const button = page.locator(selector).last();
    if (await button.count().catch(() => 0)) {
      await button.click({ timeout: 10_000 });
      return;
    }
  }

  throw new Error("Could not find AlphaPai login button.");
}

async function waitForInteractiveLogin(page, returnUrl) {
  console.log("Detected AlphaPai login page. Please complete login in the opened Edge window; waiting up to 5 minutes...");
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    if (!page.url().includes("/login")) {
      if (returnUrl) {
        await page.goto(returnUrl, { waitUntil: "domcontentloaded" });
      }
      return;
    }
  }

  throw new Error("Timed out waiting for AlphaPai interactive login.");
}

async function saveStorageState(page, config, rootDir) {
  const authPath = path.join(rootDir, config.authFile || "runtime/auth.json");
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  await page.context().storageState({ path: authPath });
}

function readCredentials(config, rootDir) {
  const fromEnv = {
    phone: process.env.ALPHA_PHONE || "",
    password: process.env.ALPHA_PASSWORD || ""
  };
  if (fromEnv.phone && fromEnv.password) return fromEnv;

  const credentialsPath = path.join(rootDir, config.credentialsFile || "runtime/alphapai-credentials.json");
  if (!fs.existsSync(credentialsPath)) return {};

  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
    return {
      phone: String(parsed.phone || parsed.account || parsed.username || ""),
      password: String(parsed.password || "")
    };
  } catch {
    return {};
  }
}
