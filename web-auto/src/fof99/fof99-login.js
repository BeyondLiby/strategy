import fs from "node:fs";
import path from "node:path";

let activeLoginRecovery = null;

export async function ensureFof99LoggedIn(page, config, rootDir, options = {}) {
  const invalid = await isAuthInvalid(page, config);
  if (!invalid) return false;

  if (!activeLoginRecovery) {
    activeLoginRecovery = recoverLogin(page, config, rootDir, options)
      .finally(() => {
        activeLoginRecovery = null;
      });
  } else {
    console.log("Another worker is refreshing fof99 login state; waiting...");
  }

  await activeLoginRecovery;

  if (options.returnUrl) {
    await page.goto(options.returnUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  }

  if (await isAuthInvalid(page, config)) {
    throw new Error("fof99 login recovery finished, but this page is still not authenticated.");
  }

  return true;
}

export async function isAuthInvalid(page, config) {
  if (isLoginUrl(page.url(), config)) return true;
  const text = await page.locator("body").innerText({ timeout: 1500 }).catch(() => "");
  return text.includes("\u8d26\u53f7\u5728\u5176\u5b83\u8bbe\u5907\u767b\u5f55")
    || text.includes("\u8bf7\u5237\u65b0\u9875\u9762\u540e\u91cd\u65b0\u767b\u5f55");
}

export function isLoginUrl(url, config) {
  return String(url || "").includes(config.fof99?.loginCheckPath || "/login");
}

async function recoverLogin(page, config, rootDir, options) {
  const credentials = readCredentials(config, rootDir);
  if (credentials.account && credentials.password) {
    console.log("fof99 login expired; attempting automatic login with saved credentials...");
    await autoLogin(page, credentials, config, rootDir);
    console.log("fof99 automatic login succeeded.");
    return;
  }

  if (options.headless) {
    throw new Error(
      "fof99 login expired and no credentials were found. Set FOF99_ACCOUNT/FOF99_PASSWORD, " +
      "or create runtime/fof99-credentials.json, or run HEADLESS=false npm.cmd run fof99:extract for interactive login."
    );
  }

  await waitForInteractiveLogin(page, config, options.returnUrl);
  await saveStorageState(page, config, rootDir);
}

async function autoLogin(page, credentials, config, rootDir) {
  await gotoLoginPage(page, config);
  await choosePasswordLogin(page);
  await fillCredentials(page, credentials);
  await clickLoginButton(page);
  await page.waitForTimeout(1000);

  if (isLoginUrl(page.url(), config)) {
    await page.waitForURL((url) => !isLoginUrl(url.href, config), { timeout: 30_000 }).catch(() => {});
  }
  if (isLoginUrl(page.url(), config)) {
    await page.locator("input[type='password']").first().press("Enter").catch(() => {});
    await page.waitForURL((url) => !isLoginUrl(url.href, config), { timeout: 10_000 }).catch(() => {});
  }

  if (await isAuthInvalid(page, config)) {
    const debugDir = path.join(rootDir, "output", "debug");
    fs.mkdirSync(debugDir, { recursive: true });
    await page.screenshot({ path: path.join(debugDir, "fof99-auto-login-failed.png"), fullPage: true }).catch(() => {});
    const debug = {
      url: page.url(),
      title: await page.title().catch(() => ""),
      text: await page.locator("body").innerText({ timeout: 1000 }).catch(() => "")
    };
    fs.writeFileSync(path.join(debugDir, "fof99-auto-login-failed.json"), JSON.stringify(debug, null, 2), "utf8");
    throw new Error("Automatic fof99 login did not complete. The site may require SMS, captcha, or another interactive step.");
  }

  await saveStorageState(page, config, rootDir);
}

async function gotoLoginPage(page, config) {
  const origin = config.fof99?.origin || "https://mp.fof99.com";
  const loginUrl = new URL(config.fof99?.loginCheckPath || "/login", origin).href;
  if (!isLoginUrl(page.url(), config)) {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  }
}

async function choosePasswordLogin(page) {
  const candidates = [
    "text=\u8d26\u53f7\u5bc6\u7801\u767b\u5f55",
    "text=\u5bc6\u7801\u767b\u5f55",
    "text=\u7528\u6237\u540d\u5bc6\u7801\u767b\u5f55"
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

    if (!passwordFilled && (type === "password" || /\u5bc6\u7801|password/.test(label))) {
      await input.fill(credentials.password);
      passwordFilled = true;
      continue;
    }

    if (!accountFilled && (type === "" || type === "tel" || type === "text" || /\u624b\u673a|\u8d26\u53f7|\u5e10\u53f7|\u7528\u6237|phone|mobile|account|user/.test(label))) {
      await input.fill(credentials.account);
      accountFilled = true;
    }
  }

  if (!accountFilled || !passwordFilled) {
    throw new Error("Could not find fof99 account/password inputs on login page.");
  }
}

async function clickLoginButton(page) {
  const candidates = [
    "button:has-text('\u767b\u5f55')",
    ".el-button:has-text('\u767b\u5f55')",
    "[role='button']:has-text('\u767b\u5f55')",
    "text=\u767b\u5f55",
    "button[type='submit']"
  ];

  for (const selector of candidates) {
    const targets = page.locator(selector);
    const count = await targets.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const button = targets.nth(index);
      if (!(await button.isVisible().catch(() => false))) continue;
      const text = (await button.innerText().catch(() => "")).replace(/\s+/g, "").trim();
      if (text && !text.includes("\u767b\u5f55")) continue;
      await button.click({ timeout: 10_000, force: true });
      return;
    }
  }

  const clicked = await page.evaluate(() => {
    const loginText = "\u767b\u5f55";
    const textOf = (element) => (element?.innerText || element?.textContent || "").replace(/\s+/g, "").trim();
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    const targets = [...document.querySelectorAll("button, [role='button'], .el-button, a, div, span")]
      .filter(visible)
      .filter((element) => textOf(element) === loginText)
      .map((element) => {
        const box = element.getBoundingClientRect();
        return { element, area: box.width * box.height, top: box.top };
      })
      .sort((a, b) => b.area - a.area || b.top - a.top);

    const target = targets[0]?.element;
    if (!target) return false;
    target.click();
    return true;
  });
  if (clicked) return;

  const passwordInput = page.locator("input[type='password']").first();
  if (await passwordInput.count().catch(() => 0)) {
    await passwordInput.press("Enter").catch(() => {});
    return;
  }

  throw new Error("Could not find fof99 login button.");
}

async function waitForInteractiveLogin(page, config, returnUrl) {
  console.log("Detected fof99 login issue. Please complete login in the opened Edge window; waiting up to 5 minutes...");
  await gotoLoginPage(page, config);
  const deadline = Date.now() + 5 * 60 * 1000;

  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    if (!(await isAuthInvalid(page, config))) {
      if (returnUrl) {
        await page.goto(returnUrl, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      }
      return;
    }
  }

  throw new Error("Timed out waiting for fof99 interactive login.");
}

async function saveStorageState(page, config, rootDir) {
  if (config.session?.storageStateBackup === false) return;
  const authPath = path.join(rootDir, config.authFile || "runtime/fof99-auth.json");
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  await page.context().storageState({ path: authPath });
}

function readCredentials(config, rootDir) {
  const fromEnv = {
    account: process.env.FOF99_ACCOUNT || process.env.FOF99_USERNAME || "",
    password: process.env.FOF99_PASSWORD || ""
  };
  if (fromEnv.account && fromEnv.password) return fromEnv;

  const credentialsPath = path.join(rootDir, config.credentialsFile || "runtime/fof99-credentials.json");
  if (!fs.existsSync(credentialsPath)) return {};

  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
    return {
      account: String(parsed.account || parsed.username || parsed.phone || ""),
      password: String(parsed.password || "")
    };
  } catch {
    return {};
  }
}
