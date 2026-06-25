import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const msedgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

export async function launchAlphaPaiContext(config, rootDir, options = {}) {
  const userDataDir = path.join(rootDir, config.authProfileDir || "runtime/alphapai-profile");
  fs.mkdirSync(userDataDir, { recursive: true });
  const headless = options.headless ?? resolveHeadless(config);

  return chromium.launchPersistentContext(userDataDir, {
    executablePath: fs.existsSync(msedgePath) ? msedgePath : undefined,
    channel: fs.existsSync(msedgePath) ? undefined : config.browser?.channel || "msedge",
    headless,
    acceptDownloads: true,
    viewport: options.viewport || config.browser?.viewport || { width: 1440, height: 1200 },
    timezoneId: options.timezoneId || config.browser?.timezoneId || "Asia/Shanghai",
    locale: "zh-CN",
    slowMo: options.slowMo || 0
  });
}

export function alphaPaiProfileDir(config, rootDir) {
  return path.join(rootDir, config.authProfileDir || "runtime/alphapai-profile");
}

function resolveHeadless(config) {
  if (process.env.HEADLESS === "true") return true;
  if (process.env.HEADLESS === "false") return false;
  return config.browser?.headless === true;
}
