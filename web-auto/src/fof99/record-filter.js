import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { launchFof99Context } from "./persistent-context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const config = readJson(path.join(rootDir, "config/fof99-net-values.json"));
const outputRoot = path.join(rootDir, config.outputDir || "output/fof99-net-values");
const startUrl = config.fof99?.startUrl || "https://mp.fof99.com/fund/all";
const origin = config.fof99?.origin || "https://mp.fof99.com";
const detailPath = config.fof99?.detailPath || "/fund/view/";
const selectors = config.selectors || {};
const recordDir = path.join(outputRoot, "debug", `filter-record-${timestampForFile(new Date())}`);
fs.mkdirSync(recordDir, { recursive: true });

const events = [];
const network = [];
const context = await launchFof99Context(config, rootDir, {
  headless: false,
  slowMo: 80,
  viewport: config.browser?.viewport || { width: 1440, height: 1200 }
});

try {
  const page = await context.newPage();
  page.on("request", (request) => {
    const type = request.resourceType();
    if (!["xhr", "fetch", "document"].includes(type)) return;
    network.push({
      time: new Date().toISOString(),
      event: "request",
      method: request.method(),
      resourceType: type,
      url: request.url(),
      postData: request.postData() || ""
    });
  });
  page.on("response", async (response) => {
    const request = response.request();
    const type = request.resourceType();
    if (!["xhr", "fetch", "document"].includes(type)) return;
    network.push({
      time: new Date().toISOString(),
      event: "response",
      status: response.status(),
      method: request.method(),
      resourceType: type,
      url: response.url()
    });
  });

  await page.exposeBinding("recordFof99Event", (_source, payload) => {
    events.push({ time: new Date().toISOString(), ...payload });
  });

  await page.goto(startUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await installDomRecorder(page);

  await dumpSnapshot(page, "before");
  console.log(`[record] opened: ${startUrl}`);
  console.log(`[record] output dir: ${recordDir}`);
  console.log("[record] 请在打开的 Edge 里手动完成：取消“不限” -> 勾选“私募证券基金” -> 点击“保存”。");
  console.log("[record] 操作完成并看到列表变化后，回到这个终端按 Enter。");

  const rl = readline.createInterface({ input, output });
  await rl.question("");
  rl.close();

  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await dumpSnapshot(page, "after");

  fs.writeFileSync(path.join(recordDir, "events.json"), JSON.stringify(events, null, 2), "utf8");
  fs.writeFileSync(path.join(recordDir, "network.json"), JSON.stringify(network, null, 2), "utf8");
  console.log(`[record] saved events: ${path.join(recordDir, "events.json")}`);
  console.log(`[record] saved network: ${path.join(recordDir, "network.json")}`);
  console.log(`[record] saved screenshots/html/state in: ${recordDir}`);
} finally {
  await context.close().catch(() => {});
}

async function installDomRecorder(page) {
  await page.evaluate(() => {
    if (window.__fof99RecorderInstalled) return;
    window.__fof99RecorderInstalled = true;
    const textOf = (element) => (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
    const describe = (element) => {
      if (!element) return {};
      const box = element.getBoundingClientRect();
      const attrs = {};
      for (const name of ["id", "class", "type", "role", "title", "aria-label", "aria-checked", "name", "placeholder"]) {
        const value = element.getAttribute?.(name);
        if (value) attrs[name] = value;
      }
      const path = [];
      let node = element;
      while (node && node.nodeType === 1 && path.length < 6) {
        let part = node.tagName.toLowerCase();
        if (node.id) part += `#${node.id}`;
        if (node.className && typeof node.className === "string") {
          part += `.${node.className.trim().replace(/\s+/g, ".").slice(0, 80)}`;
        }
        path.push(part);
        node = node.parentElement;
      }
      return {
        tag: element.tagName?.toLowerCase(),
        text: textOf(element).slice(0, 120),
        attrs,
        box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
        path: path.join(" < ")
      };
    };
    document.addEventListener("click", (event) => {
      window.recordFof99Event?.({
        type: "click",
        target: describe(event.target),
        label: describe(event.target?.closest?.("label")),
        button: describe(event.target?.closest?.("button, a, [role='button'], .el-button"))
      });
    }, true);
    document.addEventListener("change", (event) => {
      window.recordFof99Event?.({
        type: "change",
        target: describe(event.target),
        value: event.target?.value,
        checked: event.target?.checked
      });
    }, true);
  });
}

async function dumpSnapshot(page, prefix) {
  const state = await page.evaluate((payload) => {
    const { origin, detailPath, selectors } = payload;
    const textOf = (element) => (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    const checkedText = (labelText) => {
      const label = [...document.querySelectorAll("label, span, div")]
        .filter(visible)
        .filter((element) => textOf(element) === labelText || textOf(element).includes(labelText))
        .sort((a, b) => textOf(a).length - textOf(b).length)[0];
      const root = label?.closest("label") || label?.closest(".el-checkbox") || label?.closest("[role='checkbox']") || label?.parentElement;
      return Boolean(
        root?.querySelector("input[type='checkbox']")?.checked ||
        root?.classList.contains("is-checked") ||
        root?.getAttribute("aria-checked") === "true" ||
        root?.querySelector(".is-checked")
      );
    };
    const pagination = document.querySelector(".el-pagination, .ant-pagination") || document.body;
    const paginationText = textOf(pagination);
    const totalItems = Number((paginationText.match(/\u5171\s*([\d,]+)\s*\u6761/) || [])[1]?.replace(/,/g, ""));
    const pageSize = Number((paginationText.match(/([\d,]+)\s*\u6761\s*\/\s*\u9875/) || [])[1]?.replace(/,/g, ""));
    const products = [];
    const normalizeUrl = (href) => {
      try {
        return new URL(href, origin).href;
      } catch {
        return "";
      }
    };
    for (const link of [...document.querySelectorAll(selectors.productLinks || "a[href*='/fund/view/']")].filter(visible)) {
      const url = normalizeUrl(link.getAttribute("href"));
      if (url.includes(detailPath)) products.push({ name: textOf(link), url });
    }
    const selectedLine = [...document.querySelectorAll("div, span")]
      .filter(visible)
      .map(textOf)
      .filter((text) => text.includes("\u5df2\u9009\u6761\u4ef6"))
      .sort((a, b) => a.length - b.length)[0] || "";
    return {
      url: location.href,
      title: document.title,
      totalItems,
      pageSize,
      totalPages: totalItems && pageSize ? Math.ceil(totalItems / pageSize) : null,
      unlimitedChecked: checkedText("\u4e0d\u9650"),
      privateSecuritiesFundChecked: checkedText("\u79c1\u52df\u8bc1\u5238\u57fa\u91d1"),
      selectedLine,
      firstProducts: products.slice(0, 10)
    };
  }, { origin, detailPath, selectors });

  await page.screenshot({ path: path.join(recordDir, `${prefix}.png`), fullPage: true }).catch(() => {});
  fs.writeFileSync(path.join(recordDir, `${prefix}.html`), await page.content(), "utf8");
  fs.writeFileSync(path.join(recordDir, `${prefix}-state.json`), JSON.stringify(state, null, 2), "utf8");
  console.log(`[record:${prefix}] totalItems=${state.totalItems || ""} totalPages=${state.totalPages || ""} unlimited=${state.unlimitedChecked} private=${state.privateSecuritiesFundChecked} first=${state.firstProducts[0]?.name || ""}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function timestampForFile(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}
