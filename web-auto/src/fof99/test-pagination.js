import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureFof99LoggedIn } from "./fof99-login.js";
import { launchFof99Context } from "./persistent-context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const config = readJson(path.join(rootDir, "config/fof99-net-values.json"));
const args = parseArgs(process.argv.slice(2));

const outputRoot = path.join(rootDir, config.outputDir || "output/fof99-net-values");
const origin = config.fof99?.origin || "https://mp.fof99.com";
const startUrl = config.fof99?.startUrl || "https://mp.fof99.com/fund/all";
const detailPath = config.fof99?.detailPath || "/fund/view/";
const headless = process.env.HEADLESS !== "false" && config.browser?.headless !== false;
const selectors = config.selectors || {};
const delays = config.delays || {};

const maxPages = Math.max(1, Number(args.maxPages || process.env.MAX_PAGES || 120));
const waitMs = Math.max(0, Number(args.waitMs || process.env.FOF99_PAGE_TEST_WAIT_MS || 500));
const logDir = path.join(outputRoot, "logs");
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, `pagination-test-${timestampForFile(new Date())}.csv`);
initCsv(logPath, [
  "time",
  "pageIndex",
  "currentPage",
  "totalPages",
  "totalItems",
  "pageSize",
  "visibleProducts",
  "firstProduct",
  "lastProduct",
  "status",
  "detail"
]);

const context = await launchFof99Context(config, rootDir, { headless });
context.setDefaultTimeout(30_000);

console.log(`[pagination-test] log: ${logPath}`);
console.log(`[pagination-test] maxPages=${maxPages} headless=${headless}`);

try {
  const page = await context.newPage();
  await gotoReady(page, startUrl);
  await ensureFof99LoggedIn(page, config, rootDir, { returnUrl: startUrl, headless });
  await ensurePageExists(page);
  await dismissGuides(page);
  await applyPrivateSecuritiesFundFilterV3(page);

  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
    await settle(page);
    await dismissGuides(page);

    const products = await collectProductsOnCurrentPage(page);
    const pagination = await readPaginationState(page);
    const firstProduct = products[0]?.name || "";
    const lastProduct = products.at(-1)?.name || "";
    const line = [
      `pageIndex=${pageIndex}`,
      `currentPage=${pagination.currentPage || ""}`,
      `totalPages=${pagination.totalPages || ""}`,
      `totalItems=${pagination.totalItems || ""}`,
      `visibleProducts=${products.length}`,
      firstProduct ? `first=${truncate(firstProduct, 22)}` : "",
      lastProduct ? `last=${truncate(lastProduct, 22)}` : ""
    ].filter(Boolean).join(" ");
    console.log(`[pagination-test] ${line}`);
    appendCsv(logPath, [
      new Date().toISOString(),
      pageIndex,
      pagination.currentPage || "",
      pagination.totalPages || "",
      pagination.totalItems || "",
      pagination.pageSize || "",
      products.length,
      firstProduct,
      lastProduct,
      "ok",
      ""
    ]);

    if (pageIndex >= maxPages) {
      appendCsv(logPath, [
        new Date().toISOString(),
        pageIndex,
        pagination.currentPage || "",
        pagination.totalPages || "",
        pagination.totalItems || "",
        pagination.pageSize || "",
        products.length,
        firstProduct,
        lastProduct,
        "stopped",
        `maxPages reached: ${maxPages}`
      ]);
      break;
    }

    const nextPageResult = await goNextPage(page);
    if (!nextPageResult.moved) {
      appendCsv(logPath, [
        new Date().toISOString(),
        pageIndex,
        pagination.currentPage || "",
        pagination.totalPages || "",
        pagination.totalItems || "",
        pagination.pageSize || "",
        products.length,
        firstProduct,
        lastProduct,
        "stopped",
        nextPageResult.reason || "no next page"
      ]);
      console.log(`[pagination-test] stopped: ${nextPageResult.reason || "no next page"}`);
      break;
    }

    if (waitMs) await page.waitForTimeout(waitMs);
  }
} finally {
  await context.close().catch(() => {});
}

async function collectProductsOnCurrentPage(page) {
  const products = new Map();

  for (let index = 0; index < 10; index += 1) {
    for (const product of await readVisibleProducts(page)) {
      products.set(product.url, product);
    }

    const before = await page.evaluate(() => document.scrollingElement?.scrollTop || 0);
    await page.mouse.wheel(0, 500);
    await politePause("listScrollMs");
    const after = await page.evaluate(() => document.scrollingElement?.scrollTop || 0);
    if (after === before) break;
  }

  await page.evaluate(() => document.scrollingElement?.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(300);
  return [...products.values()];
}

async function readVisibleProducts(page) {
  return page.evaluate((payload) => {
    const { origin, detailPath, selectors } = payload;
    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    const textOf = (element) => (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    const normalizeUrl = (href) => {
      if (!href) return "";
      try {
        return new URL(href, origin).href;
      } catch {
        return "";
      }
    };

    const anchors = [...document.querySelectorAll(selectors.productLinks || "a[href*='/fund/view/']")].filter(visible);
    const fallbackAnchors = [...document.querySelectorAll(selectors.productNameFallback || "a, .el-link, td a")]
      .filter((element) => visible(element) && normalizeUrl(element.getAttribute("href")).includes(detailPath));

    const result = [];
    const seen = new Set();
    for (const element of [...anchors, ...fallbackAnchors]) {
      const url = normalizeUrl(element.getAttribute("href"));
      if (!url || !url.includes(detailPath) || seen.has(url)) continue;
      seen.add(url);
      const name = textOf(element) || url.split("/").filter(Boolean).pop() || "unknown";
      result.push({ name, url });
    }

    return result;
  }, { origin, detailPath, selectors });
}

async function goNextPage(page) {
  await dismissGuides(page);
  const nextSelector = ".el-pagination .btn-next, .ant-pagination-next, button[aria-label='Next page'], li[title='下一页']";
  const disabledSelector = selectors.disabledPageButton || ".is-disabled, .ant-pagination-disabled, [disabled], [aria-disabled='true']";
  const next = page.locator(nextSelector).last();
  if (!(await next.count())) return { moved: false, reason: "next button not found" };

  await page.evaluate(() => document.scrollingElement?.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(300);
  const beforePage = await readPaginationState(page);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const beforeKey = await productListKey(page);
    const disabled = await next.evaluate((element, disabledSelector) => {
      return element.matches(disabledSelector) || Boolean(element.closest(disabledSelector));
    }, disabledSelector).catch(() => false);
    if (disabled) {
      return {
        moved: false,
        reason: formatPaginationStopReason("next button disabled", beforePage)
      };
    }

    await next.click({ timeout: 5000 }).catch(async () => {
      await next.click({ force: true, timeout: 5000 });
    });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await politePause("betweenPagesMs");

    const moved = await waitForNextPage(page, beforePage, beforeKey);
    if (moved) return { moved: true };
    await page.waitForTimeout(1000 * attempt);
  }

  const afterPage = await readPaginationState(page);
  return {
    moved: false,
    reason: formatPaginationStopReason("product list did not change after next click retries", afterPage || beforePage)
  };
}

async function productListKey(page) {
  const products = await readVisibleProducts(page).catch(() => []);
  return products.map((product) => product.url).slice(0, 10).join("|");
}

async function waitForNextPage(page, beforePage, beforeKey) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const afterPage = await readPaginationState(page);
    if (
      Number.isFinite(beforePage?.currentPage) &&
      Number.isFinite(afterPage?.currentPage) &&
      afterPage.currentPage > beforePage.currentPage
    ) {
      return true;
    }
    const afterKey = await productListKey(page);
    if (afterKey && afterKey !== beforeKey) return true;
  }
  return false;
}

async function readPaginationState(page) {
  return page.evaluate(() => {
    const textOf = (element) => (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
    const pagination = document.querySelector(".el-pagination, .ant-pagination") || document.body;
    const text = textOf(pagination);
    const activeText = textOf(
      pagination.querySelector(".number.active, .number.is-active, .el-pager .active, .ant-pagination-item-active")
    );
    const currentPage = Number((activeText.match(/\d+/) || [])[0]);
    const totalItems = Number((text.match(/共\s*([\d,]+)\s*条/) || [])[1]?.replace(/,/g, ""));
    const pageSize = Number((text.match(/([\d,]+)\s*条\s*\/\s*页/) || [])[1]?.replace(/,/g, ""));
    const pageNumbers = [...pagination.querySelectorAll(".number, .el-pager li, .ant-pagination-item")]
      .map((element) => Number(textOf(element).replace(/[^\d]/g, "")))
      .filter(Number.isFinite);
    const visibleLastPage = pageNumbers.length ? Math.max(...pageNumbers) : undefined;
    const totalPages = totalItems && pageSize ? Math.ceil(totalItems / pageSize) : visibleLastPage;
    return { currentPage, totalItems, pageSize, totalPages, visibleLastPage, text };
  }).catch(() => ({}));
}

async function ensureLoggedInV2(page, returnUrl) {
  if (!page.url().includes(config.fof99?.loginCheckPath || "/login")) return;
  if (headless) {
    throw new Error("fof99 auth expired. Re-run without --headless so the script can open a login window.");
  }
  await waitForManualLogin(page, returnUrl, "login page detected");
}

async function ensurePageExistsV2(page) {
  const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  if (text.includes("\u8d26\u53f7\u5728\u5176\u5b83\u8bbe\u5907\u767b\u5f55") || text.includes("\u8bf7\u5237\u65b0\u9875\u9762\u540e\u91cd\u65b0\u767b\u5f55")) {
    if (headless) {
      throw new Error("fof99 auth expired because the account was logged in elsewhere. Re-run without --headless.");
    }
    await waitForManualLogin(page, startUrl, "account was logged in on another device");
    return;
  }
  if (page.url().includes("/404") || /^404\b/.test(text.trim())) {
    throw new Error(`Page not found: ${page.url()}`);
  }
}

async function waitForManualLogin(page, returnUrl, reason) {
  console.log(`[auth] ${reason}. Please finish fof99 login in the opened Edge window. Waiting up to 10 minutes...`);
  const loginUrl = new URL(config.fof99?.loginCheckPath || "/login", origin).href;
  if (!page.url().includes(config.fof99?.loginCheckPath || "/login")) {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  }

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    const currentUrl = page.url();
    const text = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
    const stillInvalid = currentUrl.includes(config.fof99?.loginCheckPath || "/login")
      || text.includes("\u8d26\u53f7\u5728\u5176\u5b83\u8bbe\u5907\u767b\u5f55")
      || text.includes("\u8bf7\u5237\u65b0\u9875\u9762\u540e\u91cd\u65b0\u767b\u5f55");
    if (!stillInvalid && currentUrl.startsWith(origin) && !currentUrl.includes("/404") && !/^404\b/.test(text.trim())) {
      await gotoReady(page, returnUrl);
      if (config.session?.storageStateBackup !== false) {
        await page.context().storageState({ path: authPath }).catch(() => {});
      }
      console.log("[auth] fof99 login restored; continuing pagination test.");
      return;
    }
  }

  throw new Error("Timed out waiting for fof99 login.");
}

async function ensureLoggedIn(page, returnUrl) {
  if (!page.url().includes(config.fof99?.loginCheckPath || "/login")) return;
  if (headless) {
    throw new Error("fof99 未登录或登录态已失效。请先运行 npm.cmd run fof99:login。");
  }

  console.log("检测到登录页。请在打开的 Edge 窗口中完成登录，脚本会等待最多 5 分钟后继续。");
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    if (!page.url().includes(config.fof99?.loginCheckPath || "/login")) {
      await gotoReady(page, returnUrl);
      return;
    }
  }

  throw new Error("等待登录超时。");
}

async function ensurePageExists(page) {
  const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  if (/账号在其它设备登录|请刷新页面后重新登录/.test(text)) {
    throw new Error("fof99 登录态不可用：账号在其它设备登录或需要重新登录。请运行 npm.cmd run fof99:login。");
  }
  if (page.url().includes("/404") || /^404\b/.test(text.trim())) {
    throw new Error(`页面不存在：${page.url()}`);
  }
}

async function applyPrivateSecuritiesFundFilterV3(page) {
  const before = await readFof99PrivateFundListState(page);
  if (before.isApplied) return;

  let lastState = before;
  let lastClick = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const responsePromise = page.waitForResponse((response) => {
      const request = response.request();
      if (!response.url().includes("/fund/advancedList") || request.method() !== "POST") return false;
      const postData = request.postData() || "";
      try {
        const body = JSON.parse(postData);
        return Array.isArray(body.fundType) && body.fundType.includes(2);
      } catch {
        return postData.includes("\"fundType\":[2]");
      }
    }, { timeout: 20_000 }).catch(() => null);

    lastClick = await clickPrivateSecuritiesFundCurTag(page);
    if (!lastClick.ok) {
      await page.waitForTimeout(700 * attempt);
      continue;
    }

    await responsePromise;
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      lastState = await readFof99PrivateFundListState(page);
      if (lastState.isApplied) return;
      await page.waitForTimeout(500);
    }
  }

  throw new Error(
    "Failed to apply fof99 private securities fund filter: expected selected condition and totalItems < 400000; " +
    `actual totalItems=${lastState.pagination?.totalItems ?? ""} totalPages=${lastState.pagination?.totalPages ?? ""} ` +
    `selectedCondition=${lastState.selectedCondition || ""} first=${lastState.firstProduct || ""} ` +
    `click=${JSON.stringify(lastClick || {})}`
  );
}

async function readFof99PrivateFundListState(page) {
  const [pagination, products, selectedCondition] = await Promise.all([
    readPaginationState(page).catch(() => ({})),
    readVisibleProducts(page).catch(() => []),
    page.evaluate(() => {
      const selectedText = "\u5df2\u9009\u6761\u4ef6";
      const textOf = (element) => (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
      const visible = (element) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
      };
      return [...document.querySelectorAll("div, section, span")]
        .filter(visible)
        .map((element) => {
          const box = element.getBoundingClientRect();
          return { text: textOf(element), top: box.top, length: textOf(element).length };
        })
        .filter((item) => item.text.includes(selectedText))
        .sort((a, b) => a.length - b.length || a.top - b.top)[0]?.text || "";
    }).catch(() => "")
  ]);

  const selected = selectedCondition.includes("\u57fa\u91d1\u7c7b\u578b") &&
    selectedCondition.includes("\u79c1\u52df\u8bc1\u5238\u57fa\u91d1");
  const totalItems = Number(pagination?.totalItems);
  const filteredTotal = Number.isFinite(totalItems) && totalItems > 0 && totalItems < 400_000;
  return {
    pagination,
    products,
    selectedCondition,
    firstProduct: products[0]?.name || "",
    isApplied: selected && filteredTotal
  };
}

async function clickPrivateSecuritiesFundCurTag(page) {
  return page.evaluate(() => {
    const privateText = "\u79c1\u52df\u8bc1\u5238\u57fa\u91d1";
    const fundTypeText = "\u57fa\u91d1\u7c7b\u578b";
    const textOf = (element) => (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    const sortTopLeft = (a, b) => {
      const ab = a.getBoundingClientRect();
      const bb = b.getBoundingClientRect();
      return ab.top - bb.top || ab.left - bb.left;
    };
    const findTag = () => [...document.querySelectorAll(".cur-tag")]
      .filter(visible)
      .filter((element) => textOf(element).includes(privateText))
      .sort(sortTopLeft)[0];

    let tag = findTag();
    if (!tag) {
      const tab = [...document.querySelectorAll("button, a, span, div")]
        .filter(visible)
        .filter((element) => textOf(element).includes(fundTypeText))
        .sort(sortTopLeft)[0];
      tab?.click();
      tag = findTag();
    }

    if (!tag) return { ok: false, reason: "private securities fund cur-tag not found" };

    const target = tag.querySelector(".icon-block") || tag;
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    target.click();
    return {
      ok: true,
      tagText: textOf(tag),
      tagClass: String(tag.className || ""),
      targetClass: String(target.className || "")
    };
  });
}

async function applyPrivateSecuritiesFundFilterV2(page) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const beforeKey = await productListKey(page).catch(() => "");
    const state = await setPrivateSecuritiesFundFilterOnce(page);
    if (state.ok && !state.unlimitedChecked && state.selectedCondition) {
      await clickFof99FilterSave(page);
      await waitForFof99FilterApply(page, beforeKey);
      const afterState = await readPrivateSecuritiesFundFilterState(page);
      if (afterState.ok && !afterState.unlimitedChecked && afterState.selectedCondition) return;
    }
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(800 * attempt);
  }

  const state = await readPrivateSecuritiesFundFilterState(page);
  throw new Error(
    "Failed to apply fund type filter: expected unlimited=false and selectedCondition=true; " +
    `actual unlimited=${state.unlimitedChecked} private=${state.privateChecked} selectedCondition=${state.selectedCondition} reason=${state.reason || ""}`
  );
}

async function clickFof99FilterSave(page) {
  const clicked = await page.evaluate(() => {
    const saveText = "\u4fdd\u5b58";
    const textOf = (element) => (element?.innerText || element?.textContent || "").replace(/\s+/g, "").trim();
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    const candidates = [...document.querySelectorAll("button, a, span, div")]
      .filter(visible)
      .filter((element) => textOf(element) === saveText)
      .map((element) => {
        const box = element.getBoundingClientRect();
        return { element, top: box.top, left: box.left, area: box.width * box.height };
      })
      .sort((a, b) => b.left - a.left || a.top - b.top || b.area - a.area);
    const target = candidates[0]?.element;
    if (!target) return false;
    target.click();
    return true;
  });

  if (!clicked) throw new Error("Could not find fof99 filter save button.");
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function waitForFof99FilterApply(page, beforeKey) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const afterKey = await productListKey(page).catch(() => "");
    if (afterKey && afterKey !== beforeKey) return true;
    const pagination = await readPaginationState(page);
    if (Number.isFinite(pagination.totalItems) && pagination.totalItems < 400000) return true;
  }
  return false;
}

async function setPrivateSecuritiesFundFilterOnce(page) {
  return page.evaluate(() => {
    const fundTypeText = "\u57fa\u91d1\u7c7b\u578b";
    const unlimitedText = "\u4e0d\u9650";
    const privateSecuritiesFundText = "\u79c1\u52df\u8bc1\u5238\u57fa\u91d1";
    const textOf = (element) => (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    const rows = [...document.querySelectorAll("div, section, form, tr")]
      .filter(visible)
      .filter((element) => textOf(element).includes(fundTypeText) && textOf(element).includes(privateSecuritiesFundText));
    const row = rows.sort((a, b) => textOf(a).length - textOf(b).length)[0];
    if (!row) return { ok: false, reason: "fund type filter row not found" };

    const optionRoot = (optionText) => {
      const labels = [...row.querySelectorAll("label, span, div")]
        .filter(visible)
        .filter((element) => textOf(element) === optionText || textOf(element).includes(optionText));
      const label = labels.sort((a, b) => textOf(a).length - textOf(b).length)[0];
      if (!label) return null;
      return label.closest("label")
        || label.closest(".el-checkbox")
        || label.closest("[role='checkbox']")
        || label.parentElement;
    };
    const checked = (root) => Boolean(
      root?.querySelector("input[type='checkbox']")?.checked ||
      root?.classList.contains("is-checked") ||
      root?.getAttribute("aria-checked") === "true" ||
      root?.querySelector(".is-checked")
    );
    const clickOption = (root) => {
      const input = root?.querySelector("input[type='checkbox']");
      (input || root)?.click();
    };

    const unlimitedRoot = optionRoot(unlimitedText);
    const privateRoot = optionRoot(privateSecuritiesFundText);
    if (!unlimitedRoot) return { ok: false, reason: "unlimited option not found" };
    if (!privateRoot) return { ok: false, reason: "private securities fund option not found" };

    let unlimitedChecked = checked(unlimitedRoot);
    let privateChecked = checked(privateRoot);
    let changed = false;
    if (unlimitedChecked) {
      clickOption(unlimitedRoot);
      changed = true;
    }
    if (!privateChecked) {
      clickOption(privateRoot);
      changed = true;
    }

    unlimitedChecked = checked(unlimitedRoot);
    privateChecked = checked(privateRoot);
    const pageText = document.body.innerText || "";
    const selectedCondition = pageText.includes("\u5df2\u9009\u6761\u4ef6")
      && pageText.includes(fundTypeText)
      && pageText.includes(privateSecuritiesFundText);
    return { ok: true, changed, unlimitedChecked, privateChecked, selectedCondition };
  });
}

async function readPrivateSecuritiesFundFilterState(page) {
  return page.evaluate(() => {
    const fundTypeText = "\u57fa\u91d1\u7c7b\u578b";
    const unlimitedText = "\u4e0d\u9650";
    const privateSecuritiesFundText = "\u79c1\u52df\u8bc1\u5238\u57fa\u91d1";
    const textOf = (element) => (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    const row = [...document.querySelectorAll("div, section, form, tr")]
      .filter(visible)
      .filter((element) => textOf(element).includes(fundTypeText) && textOf(element).includes(privateSecuritiesFundText))
      .sort((a, b) => textOf(a).length - textOf(b).length)[0];
    if (!row) return { ok: false, reason: "fund type filter row not found" };
    const root = (optionText) => {
      const label = [...row.querySelectorAll("label, span, div")]
        .filter(visible)
        .filter((element) => textOf(element) === optionText || textOf(element).includes(optionText))
        .sort((a, b) => textOf(a).length - textOf(b).length)[0];
      return label?.closest("label") || label?.closest(".el-checkbox") || label?.closest("[role='checkbox']") || label?.parentElement;
    };
    const checked = (element) => Boolean(
      element?.querySelector("input[type='checkbox']")?.checked ||
      element?.classList.contains("is-checked") ||
      element?.getAttribute("aria-checked") === "true" ||
      element?.querySelector(".is-checked")
    );
    const pageText = document.body.innerText || "";
    return {
      ok: true,
      unlimitedChecked: checked(root(unlimitedText)),
      privateChecked: checked(root(privateSecuritiesFundText)),
      selectedCondition: pageText.includes("\u5df2\u9009\u6761\u4ef6") && pageText.includes(fundTypeText) && pageText.includes(privateSecuritiesFundText)
    };
  }).catch((error) => ({ ok: false, reason: String(error) }));
}

async function applyPrivateSecuritiesFundFilter(page) {
  const applied = await page.evaluate(() => {
    const textOf = (element) => (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    const rows = [...document.querySelectorAll("div, section, form, tr")]
      .filter(visible)
      .filter((element) => textOf(element).includes("基金类型") && textOf(element).includes("私募证券基金"));
    const row = rows.sort((a, b) => textOf(a).length - textOf(b).length)[0];
    if (!row) return { ok: false, reason: "fund type filter row not found" };

    const labels = [...row.querySelectorAll("label, span, div")]
      .filter(visible)
      .filter((element) => textOf(element).includes("私募证券基金"));
    const label = labels.sort((a, b) => textOf(a).length - textOf(b).length)[0];
    if (!label) return { ok: false, reason: "private securities fund option not found" };

    const input = label.closest("label")?.querySelector("input") || label.parentElement?.querySelector("input");
    if (input?.checked) return { ok: true, changed: false, reason: "already selected" };

    const clickable = label.closest("label") || label;
    clickable.click();
    return { ok: true, changed: true, reason: "selected" };
  });

  if (!applied.ok) {
    throw new Error(`没有成功选择基金类型：私募证券基金。${applied.reason || ""}`);
  }

  if (applied.changed) {
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1000);
  }
}

async function dismissGuides(page) {
  await page.evaluate((selector) => {
    document.querySelectorAll(selector).forEach((element) => element.remove());
  }, selectors.guideLayers || ".el-popover, .ant-popover, .v-modal, .modal, [role='dialog']").catch(() => {});

  for (const text of ["知道了", "我知道了", "确定", "关闭"]) {
    const target = page.getByText(text, { exact: true }).first();
    if (await target.isVisible({ timeout: 500 }).catch(() => false)) {
      await target.click({ timeout: 1000 }).catch(() => {});
      await page.waitForTimeout(200);
    }
  }
}

async function gotoReady(page, url) {
  await page.goto(new URL(url, origin).href, { waitUntil: "domcontentloaded" });
  await settle(page);
}

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.locator("body").waitFor({ state: "visible" });
  await page.waitForTimeout(1000);
}

function formatPaginationStopReason(reason, pagination = {}) {
  const parts = [reason];
  if (Number.isFinite(pagination.currentPage)) parts.push(`currentPage=${pagination.currentPage}`);
  if (Number.isFinite(pagination.totalPages)) parts.push(`totalPages=${pagination.totalPages}`);
  if (Number.isFinite(pagination.totalItems)) parts.push(`totalItems=${pagination.totalItems}`);
  return parts.join(" ");
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function initCsv(filePath, header) {
  fs.writeFileSync(filePath, header.map(csvCell).join(",") + "\n", "utf8");
}

function appendCsv(filePath, row) {
  fs.appendFileSync(filePath, row.map(csvCell).join(",") + "\n", "utf8");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
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

function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

async function politePause(key) {
  const range = delays[key] || {};
  const min = Number(range.min ?? 0);
  const max = Number(range.max ?? min);
  const duration = Math.max(0, Math.round(min + Math.random() * Math.max(0, max - min)));
  if (duration > 0) await new Promise((resolve) => setTimeout(resolve, duration));
}
