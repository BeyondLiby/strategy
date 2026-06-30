import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureFof99LoggedIn } from "./fof99-login.js";
import { launchFof99Context } from "./persistent-context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const args = parseArgs(process.argv.slice(2));
const config = readJson(path.join(rootDir, "config/fof99-net-values.json"));
config.authFile = args.authFile || process.env.FOF99_RETRY_AUTH_FILE || "runtime/fof99-fail-auth.json";
config.credentialsFile = args.credentialsFile || process.env.FOF99_RETRY_CREDENTIALS_FILE || "runtime/fof99-credentials-fail.json";
config.outputDir = args.outputDir || process.env.FOF99_RETRY_OUTPUT_DIR || "output/fof99-failed-retry";
config.session ||= {};
config.session.profileDir = args.profileDir || process.env.FOF99_RETRY_PROFILE_DIR || "runtime/fof99-fail-profile";
const authPath = path.join(rootDir, config.authFile || "runtime/fof99-auth.json");
const outputRoot = path.join(rootDir, config.outputDir || "output/fof99-net-values");
const startUrl = config.fof99?.startUrl || "https://mp.fof99.com/fund/all";
const origin = config.fof99?.origin || "https://mp.fof99.com";
const detailPath = config.fof99?.detailPath || "/fund/view/";
const selectors = config.selectors || {};
const delays = config.delays || {};
const headless = process.env.HEADLESS !== "false" && config.browser?.headless !== false;
const failedFrom = args.failedFrom || process.env.FOF99_FAILED_FROM || "";
const maxPages = Number(args.maxPages || process.env.MAX_PAGES || 0);
const maxProducts = Number(args.maxProducts || process.env.MAX_PRODUCTS || 0);
const incremental = args.full !== "true" && process.env.FOF99_FULL !== "true" && config.incremental?.enabled !== false;
const skipCompleted = args.rerunCompleted !== "true" && process.env.FOF99_RERUN_COMPLETED !== "true" && config.resume?.skipCompleted !== false;
const skipExisting = args.skipExisting === "true" || process.env.FOF99_SKIP_EXISTING === "true" || config.resume?.skipExistingComplete === true;
const skipNoNetValue = args.rerunNoNetValue !== "true" && process.env.FOF99_RERUN_NO_NET_VALUE !== "true" && config.resume?.skipNoNetValue !== false;
const noNetValueConfirmations = Math.max(1, Number(args.noNetValueConfirmations || process.env.FOF99_NO_NET_VALUE_CONFIRMATIONS || config.resume?.noNetValueConfirmations || 3));
const netValueRetries = Math.max(0, Number(args.netValueRetries || process.env.FOF99_NET_VALUE_RETRIES || config.retries?.netValue || 2));
const screenshots = config.screenshots || {};
const detailConcurrency = Math.max(1, Number(args.concurrency || process.env.FOF99_CONCURRENCY || config.concurrency?.detailPages || 1));
const progressEnabled = args.progress !== "false" && process.env.FOF99_PROGRESS !== "false" && config.progress?.enabled !== false;
const progressNotifyUrl = args.notifyUrl || process.env.FOF99_NOTIFY_URL || "";
const progressNotifyTitle = args.notifyTitle || process.env.FOF99_NOTIFY_TITLE || "fof99 extract progress";
const runDate = new Date().toISOString().slice(0, 10);
const resumePath = path.join(outputRoot, "resume-state.json");

fs.mkdirSync(outputRoot, { recursive: true });
const runId = timestampForFile(new Date());
const logDir = path.join(outputRoot, "logs");
fs.mkdirSync(logDir, { recursive: true });
const liveRunLogPath = path.join(logDir, `run-log-${runId}.csv`);
const liveFailedLogPath = path.join(logDir, `failed-products-${runId}.csv`);

const context = await launchFof99Context(config, rootDir, { headless });

context.setDefaultTimeout(30_000);

const logHeader = ["time", "status", "productName", "productUrl", "detail", "errorName", "screenshot", "jsonPath"];
const failedHeader = ["time", "productName", "productUrl", "errorName", "errorMessage", "screenshot", "jsonPath"];
const logRows = [logHeader];
initCsv(liveRunLogPath, logHeader);
initCsv(liveFailedLogPath, failedHeader);
console.log(`[log] live run log: ${liveRunLogPath}`);
console.log(`[log] live failed log: ${liveFailedLogPath}`);
const metadataHeaders = [
  "primaryStrategy",
  "secondaryStrategy",
  "strategyTags",
  "operationStatus",
  "recordNumber",
  "inceptionDate",
  "privateManager",
  "companyManagementScale",
  "fundManager"
];
const allRows = [[
  "productName",
  "productUrl",
  ...metadataHeaders,
  "date",
  "unitNetValue",
  "accumulatedNetValue",
  "restoredNetValue",
  "changeRate"
]];
const metadataRows = [["productName", "productUrl", ...metadataHeaders]];
const seenProductUrls = new Set();
const resumeState = loadResumeState();
const progress = createProgress();

try {
  if (!failedFrom) {
    throw new Error("Missing --failedFrom <csv>. Pass a failed-products CSV or run-log CSV.");
  }

  const failedProducts = loadProductsFromCsv(failedFrom);
  const productsToRetry = maxProducts ? failedProducts.slice(0, maxProducts) : failedProducts;
  progress.setTarget(productsToRetry.length);

  const page = await context.newPage();
  await gotoReady(page, startUrl);
  await ensureFof99LoggedIn(page, config, rootDir, { returnUrl: startUrl, headless });
  await page.close().catch(() => {});

  console.log(`[mode] retrying ${productsToRetry.length} failed fof99 products from ${failedFrom}`);
  console.log(`[mode] profile=${config.session.profileDir} credentials=${config.credentialsFile} output=${config.outputDir}`);
  await processProducts(context, productsToRetry);
} finally {
  writeCsv(path.join(outputRoot, "net-values.csv"), allRows);
  writeCsv(path.join(outputRoot, "product-metadata.csv"), metadataRows);
  writeCsv(path.join(outputRoot, "run-log.csv"), logRows);
  await context.close().catch(() => {});
  progress.finish();
}

async function processProducts(context, products) {
  let nextIndex = 0;
  const workerCount = Math.min(detailConcurrency, products.length);

  async function worker(workerIndex) {
    while (nextIndex < products.length) {
      const product = products[nextIndex];
      nextIndex += 1;
      if (workerIndex > 0) await politePause("workerStaggerMs");
      await extractOneProduct(context, product);
      await politePause("betweenProductsMs");
    }
  }

  await Promise.all(Array.from({ length: workerCount }, (_, index) => worker(index)));
}

async function extractOneProduct(context, product) {
  progress.start(product.name);
  const page = await context.newPage();
  const productDir = path.join(outputRoot, safeName(product.name || product.id || "unknown"));
  fs.mkdirSync(productDir, { recursive: true });
  const jsonPath = path.join(productDir, "platform-net-values.json");
  const existingRows = incremental ? readExistingRows(jsonPath) : [];
  const stopDate = latestRowDate(existingRows);

  try {
    await gotoReady(page, product.url);
    await ensureFof99LoggedIn(page, config, rootDir, { returnUrl: product.url, headless });
    await ensurePageExists(page);
    await dismissGuides(page);
    await politePause("afterDetailOpenMs");
    const metadata = await extractProductMetadata(page);
    const { rows: newRows, reachedStopDate } = await collectPlatformNetValuesWithRetry(page, { stopDate });
    const rows = mergeRows(existingRows, newRows);
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({ product, metadata, detailUrl: page.url(), incremental, stopDate, reachedStopDate, rows }, null, 2),
      "utf8"
    );
    const failedPath = path.join(productDir, "failed.png");
    if (fs.existsSync(failedPath)) fs.unlinkSync(failedPath);
    if (screenshots.detail !== false) {
      await page.screenshot({ path: path.join(productDir, "detail.png"), fullPage: true }).catch(() => {});
    }

    metadataRows.push([product.name, product.url, ...metadataHeaders.map((key) => metadata[key] || "")]);

    for (const row of rows) {
      allRows.push([
        product.name,
        product.url,
        ...metadataHeaders.map((key) => metadata[key] || ""),
        row.date,
        row.unitNetValue,
        row.accumulatedNetValue,
        row.restoredNetValue,
        row.changeRate
      ]);
    }

    const detail = incremental && stopDate
      ? `${newRows.length} fetched rows, ${rows.length} total rows${reachedStopDate ? " (incremental stop)" : ""}`
      : `${rows.length} net value rows`;
    log("ok", product, detail);
    markCompleted(product, detail);
    progress.done(product.name, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorName = error instanceof Error ? error.name : "Error";
    if (isNoNetValueLikeError(message)) {
      const noNetValueState = markNoNetValue(product, message);
      const detail = `${message} (confirmation ${noNetValueState.confirmations}/${noNetValueConfirmations})`;
      if (noNetValueState.confirmed) {
        log("no-net-value", product, detail, { errorName, jsonPath });
        progress.skipped(product.name);
        return;
      }

      let failedScreenshotPath = "";
      if (screenshots.failed !== false) {
        failedScreenshotPath = path.join(productDir, "failed.png");
        await page.screenshot({ path: failedScreenshotPath, fullPage: true }).catch(() => {});
      }
      log("suspected-no-net-value", product, detail, { errorName, screenshot: failedScreenshotPath, jsonPath });
      progress.done(product.name, false);
      return;
    }
    let failedScreenshotPath = "";
    if (screenshots.failed !== false) {
      failedScreenshotPath = path.join(productDir, "failed.png");
      await page.screenshot({ path: failedScreenshotPath, fullPage: true }).catch(() => {});
    }
    log("failed", product, message, { errorName, screenshot: failedScreenshotPath, jsonPath });
    progress.done(product.name, false);
  } finally {
    await page.close().catch(() => {});
  }
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

async function collectPlatformNetValuesWithRetry(page, options = {}) {
  let lastError;
  for (let attempt = 0; attempt <= netValueRetries; attempt += 1) {
    try {
      if (attempt > 0) {
        await recoverDetailPageBeforeNetValueRetry(page, attempt);
      }
      await revealPlatformNetValue(page);
      return await collectPlatformNetValues(page, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isNoNetValueLikeError(message) || attempt >= netValueRetries) throw error;
      lastError = error;
      await page.waitForTimeout(1200 + attempt * 1200);
    }
  }

  throw lastError || new Error("\u6ca1\u6709\u8bc6\u522b\u5230\u5e73\u53f0\u51c0\u503c\u8868\u683c\u884c\u3002");
}

async function recoverDetailPageBeforeNetValueRetry(page, attempt) {
  if (attempt === 1) {
    await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
    await dismissGuides(page);
    await page.mouse.wheel(0, -900).catch(() => {});
    await page.waitForTimeout(500);
    return;
  }

  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await settle(page);
  await dismissGuides(page);
  await politePause("afterDetailOpenMs");
}

async function collectPlatformNetValues(page, options = {}) {
  const titleText = selectors.platformNetValueTitle || "平台净值";
  const collected = new Map();
  let stableRounds = 0;
  let reachedStopDate = false;
  const stopDate = options.stopDate || "";

  for (let round = 0; round < 80; round += 1) {
    const rows = await page.evaluate((payload) => {
      const { titleText, selectors } = payload;
      const textOf = (element) => (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
      const cleanCell = (text) => text.replace(/(?<=[\d.+%-])\s+(?=[\d.+%-])/g, "").trim();
      const visible = (element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
      };
      const titleNode = [...document.querySelectorAll("h1,h2,h3,h4,div,span")]
        .filter(visible)
        .find((element) => textOf(element) === titleText || textOf(element).includes(` ${titleText}`));
      const titleBox = titleNode?.getBoundingClientRect();
      const candidates = [...document.querySelectorAll(selectors.tableRows || "tbody tr, .el-table__body tr, .ant-table-tbody tr")]
        .filter(visible)
        .filter((row) => {
          if (!titleBox) return true;
          const box = row.getBoundingClientRect();
          return box.top > titleBox.top - 20 && box.left > titleBox.left - 80;
        });

      return candidates.map((row) => {
        const tableCells = [...row.querySelectorAll("th,td")];
        const directChildren = [...row.children].filter(visible);
        const cellNodes = tableCells.length
          ? tableCells
          : directChildren.length >= 5
            ? directChildren
            : [...row.querySelectorAll(".cell, .flex.items-center")];
        const cells = cellNodes
          .map(textOf)
          .map(cleanCell)
          .filter(Boolean);
        return cells;
      }).filter((cells) => /^\d{4}-\d{2}-\d{2}$/.test(cells[0] || ""));
    }, { titleText, selectors });

    const before = collected.size;
    for (const cells of rows) {
      if (stopDate && cells[0] < stopDate) {
        reachedStopDate = true;
        continue;
      }
      collected.set(cells[0], {
        date: cells[0] || "",
        unitNetValue: cells[1] || "",
        accumulatedNetValue: cells[2] || "",
        restoredNetValue: cells[3] || "",
        changeRate: cells[4] || ""
      });
      if (stopDate && cells[0] <= stopDate) {
        reachedStopDate = true;
      }
    }

    stableRounds = collected.size === before ? stableRounds + 1 : 0;
    if (reachedStopDate) break;
    const scrolled = await scrollPlatformTable(page, titleText);
    if (!scrolled && stableRounds >= 2) break;
    await politePause("detailScrollMs");
  }

  const rows = [...collected.values()].sort((a, b) => b.date.localeCompare(a.date));
  if (!rows.length) {
    throw new Error("没有识别到平台净值表格行。");
  }

  return { rows, reachedStopDate };
}

async function extractProductMetadata(page) {
  return page.evaluate(() => {
    const textOf = (element) => (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    const clean = (value) => String(value || "").replace(/[\uE000-\uF8FF]/g, "").replace(/\s+/g, " ").trim();
    const bodyText = clean(document.body.innerText || "");
    const field = (label, pattern = "[^\\s]+") => {
      const match = bodyText.match(new RegExp(`${label}\\s*[^:：]{0,8}[:：]\\s*(${pattern})`));
      return clean(match?.[1] || "");
    };

    const topTexts = [...document.querySelectorAll("span,div,a")]
      .filter(visible)
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          text: clean(textOf(element)),
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height
        };
      })
      .filter((item) => item.text && item.top > 80 && item.top < 260 && item.left > 180 && item.width < 500 && item.height < 60)
      .map((item) => item.text);

    const uniqueTopTexts = [...new Set(topTexts)];
    const operationStatus = uniqueTopTexts.find((text) => /(正常运作|正在运作|运行中|提前清算|清算|已结束|已终止|封闭|开放)/.test(text)) || "";
    const strategyPair = uniqueTopTexts.find((text) => text.includes("/") && !/首页|市场|基金|研选|组合|投资|风控|运维/.test(text)) || "";
    const [primaryStrategy = "", secondaryStrategy = ""] = strategyPair.split("/").map((part) => clean(part));
    const strategyTags = uniqueTopTexts
      .filter((text) => text !== operationStatus)
      .filter((text) => /策略|期货|股票|债券|套利|宏观|量化|多头|中性|指数|CTA/.test(text))
      .filter((text) => text.length <= 30);

    return {
      primaryStrategy,
      secondaryStrategy,
      strategyTags: strategyTags.join(";"),
      operationStatus,
      recordNumber: field("备案编号", "[A-Za-z0-9-]+"),
      inceptionDate: field("产品成立时间", "\\d{4}-\\d{2}-\\d{2}"),
      privateManager: field("私募管理人"),
      companyManagementScale: field("公司管理规模"),
      fundManager: field("基金经理")
    };
  });
}

async function scrollPlatformTable(page, titleText) {
  return page.evaluate((payload) => {
    const { titleText, selectors } = payload;
    const textOf = (element) => (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    const titleNode = [...document.querySelectorAll("h1,h2,h3,h4,div,span")]
      .filter(visible)
      .find((element) => textOf(element) === titleText || textOf(element).includes(` ${titleText}`));
    const titleBox = titleNode?.getBoundingClientRect();
    const containers = [...document.querySelectorAll(selectors.scrollContainers || ".virtual-content, .el-table__body-wrapper, .ant-table-body, main, body")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return visible(element) && element.scrollHeight > element.clientHeight + 10 && (!titleBox || box.top > titleBox.top - 80);
      })
      .sort((a, b) => {
        const aText = textOf(a);
        const bText = textOf(b);
        const aScore = Number(a.classList.contains("virtual-content")) * 100 + Number(/\d{4}-\d{2}-\d{2}/.test(aText)) * 50;
        const bScore = Number(b.classList.contains("virtual-content")) * 100 + Number(/\d{4}-\d{2}-\d{2}/.test(bText)) * 50;
        if (aScore !== bScore) return bScore - aScore;
        const leftScore = Math.abs(a.getBoundingClientRect().left - (titleBox?.left || 0));
        const rightScore = Math.abs(b.getBoundingClientRect().left - (titleBox?.left || 0));
        return leftScore - rightScore;
      });

    const target = containers[0] || document.scrollingElement || document.documentElement;
    const before = target.scrollTop;
    target.scrollTop = Math.min(target.scrollTop + Math.max(240, target.clientHeight * 0.8), target.scrollHeight);
    return target.scrollTop !== before;
  }, { titleText, selectors });
}

async function revealPlatformNetValue(page) {
  const titleText = selectors.platformNetValueTitle || "平台净值";
  const found = await page.getByText(titleText, { exact: true }).first().isVisible({ timeout: 3000 }).catch(() => false);
  if (found) return;

  for (let index = 0; index < 20; index += 1) {
    const visible = await page.getByText(titleText, { exact: true }).first().isVisible({ timeout: 500 }).catch(() => false);
    if (visible) return;
    await page.mouse.wheel(0, 650);
    await page.waitForTimeout(250);
  }

  const fuzzyFound = await page.getByText(titleText).first().isVisible({ timeout: 1000 }).catch(() => false);
  if (!fuzzyFound) throw new Error(`没有找到“${titleText}”区域。`);
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

    const anchors = [
      ...document.querySelectorAll(selectors.productLinks || "a[href*='/fund/view/']")
    ].filter(visible);

    const fallbackAnchors = [
      ...document.querySelectorAll(selectors.productNameFallback || "a, .el-link, td a")
    ].filter((element) => visible(element) && normalizeUrl(element.getAttribute("href")).includes(detailPath));

    const result = [];
    const seen = new Set();
    for (const element of [...anchors, ...fallbackAnchors]) {
      const url = normalizeUrl(element.getAttribute("href"));
      if (!url || !url.includes(detailPath) || seen.has(url)) continue;
      seen.add(url);
      const name = textOf(element) || url.split("/").filter(Boolean).pop() || "unknown";
      const id = url.split(detailPath).pop()?.split(/[?#]/)[0] || "";
      result.push({ name, url, id });
    }

    return result;
  }, { origin, detailPath, selectors });
}

async function goNextPage(page) {
  await dismissGuides(page);
  const nextSelector = selectors.nextPageButtons || ".el-pagination .btn-next, .ant-pagination-next";
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

function formatPaginationStopReason(reason, pagination = {}) {
  const parts = [reason];
  if (Number.isFinite(pagination.currentPage)) parts.push(`currentPage=${pagination.currentPage}`);
  if (Number.isFinite(pagination.totalPages)) parts.push(`totalPages=${pagination.totalPages}`);
  if (Number.isFinite(pagination.totalItems)) parts.push(`totalItems=${pagination.totalItems}`);
  return parts.join(" ");
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
      console.log("[auth] fof99 login restored; continuing extraction.");
      return;
    }
  }

  throw new Error("Timed out waiting for fof99 login.");
}

async function ensureLoggedIn(page, returnUrl) {
  if (!page.url().includes(config.fof99?.loginCheckPath || "/login")) return;
  if (headless) {
    throw new Error("未登录或登录态已失效。请先运行 npm run fof99:login，或用 HEADLESS=false npm run fof99:extract 打开可见窗口登录。");
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

function parseCsv(content) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }

  const header = rows.shift() || [];
  return rows
    .filter((values) => values.some((value) => value !== ""))
    .map((values) => Object.fromEntries(header.map((key, index) => [key, values[index] || ""])));
}

function loadProductsFromCsv(filePath) {
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Failed products CSV does not exist: ${resolvedPath}`);
  }

  const rows = parseCsv(fs.readFileSync(resolvedPath, "utf8"));
  const products = [];
  const seen = new Set();
  for (const row of rows) {
    if (row.status && ["ok", "skipped", "stopped"].includes(row.status)) continue;
    const url = row.productUrl || row.url || row.detailUrl || "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    products.push({
      name: row.productName || row.name || url.split("/").filter(Boolean).pop() || "unknown",
      url,
      id: url.split("/").filter(Boolean).pop() || ""
    });
  }

  if (!products.length) {
    throw new Error(`No failed product URLs found in CSV: ${resolvedPath}`);
  }
  return products;
}

function readExistingRows(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const payload = readJson(filePath);
    return Array.isArray(payload.rows) ? payload.rows.filter((row) => row?.date) : [];
  } catch {
    return [];
  }
}

function appendCachedProductIfComplete(product) {
  const productDir = path.join(outputRoot, safeName(product.name || product.id || "unknown"));
  const jsonPath = path.join(productDir, "platform-net-values.json");
  if (!fs.existsSync(jsonPath)) return false;

  let payload;
  try {
    payload = readJson(jsonPath);
  } catch {
    return false;
  }

  const rows = Array.isArray(payload.rows) ? payload.rows.filter((row) => row?.date) : [];
  const metadata = payload.metadata || {};
  if (!rows.length) return false;
  if (!hasRequiredMetadata(metadata)) return false;

  metadataRows.push([product.name, product.url, ...metadataHeaders.map((key) => metadata[key] || "")]);
  for (const row of rows) {
    allRows.push([
      product.name,
      product.url,
      ...metadataHeaders.map((key) => metadata[key] || ""),
      row.date,
      row.unitNetValue,
      row.accumulatedNetValue,
      row.restoredNetValue,
      row.changeRate
    ]);
  }

  return true;
}

function loadResumeState() {
  if (!fs.existsSync(resumePath)) return backfillNoNetValueFromFailedLogs({ runDate, completed: {}, noNetValue: {} });
  try {
    const state = readJson(resumePath);
    const noNetValue = state.noNetValue && typeof state.noNetValue === "object" ? state.noNetValue : {};
    if (state.runDate !== runDate) return backfillNoNetValueFromFailedLogs({ runDate, completed: {}, noNetValue });
    return backfillNoNetValueFromFailedLogs({
      runDate,
      completed: state.completed && typeof state.completed === "object" ? state.completed : {},
      noNetValue
    });
  } catch {
    return backfillNoNetValueFromFailedLogs({ runDate, completed: {}, noNetValue: {} });
  }
}

function isCompletedInCurrentRun(product) {
  return Boolean(resumeState.completed?.[product.url]);
}

function isKnownNoNetValue(product) {
  const entry = resumeState.noNetValue?.[product.url];
  if (!entry) return false;
  const confirmations = Number(entry.confirmations || 1);
  return confirmations >= noNetValueConfirmations;
}

function markCompleted(product, detail) {
  resumeState.completed[product.url] = {
    name: product.name,
    id: product.id,
    detail,
    completedAt: new Date().toISOString()
  };
  if (resumeState.noNetValue?.[product.url]) {
    delete resumeState.noNetValue[product.url];
  }
  fs.writeFileSync(resumePath, JSON.stringify(resumeState, null, 2), "utf8");
}

function markNoNetValue(product, detail) {
  resumeState.noNetValue ||= {};
  const previous = resumeState.noNetValue[product.url] || {};
  const confirmations = Number(previous.confirmations || (previous.detail ? 1 : 0)) + 1;
  resumeState.noNetValue[product.url] = {
    name: product.name,
    id: product.id,
    detail,
    confirmations,
    confirmed: confirmations >= noNetValueConfirmations,
    markedAt: previous.markedAt || new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  };
  fs.writeFileSync(resumePath, JSON.stringify(resumeState, null, 2), "utf8");
  return resumeState.noNetValue[product.url];
}

function isNoNetValueError(message) {
  return /没有识别到平台净值表格行|没有找到[“"]?平台净值[”"]?区域/.test(String(message || ""));
}

function isNoNetValueLikeError(message) {
  const text = String(message || "");
  return text.includes("\u6ca1\u6709\u8bc6\u522b\u5230\u5e73\u53f0\u51c0\u503c\u8868\u683c\u884c") ||
    /\u6ca1\u6709\u627e\u5230[\u201c"]?\u5e73\u53f0\u51c0\u503c[\u201d"]?\u533a\u57df/.test(text);
}

function backfillNoNetValueFromFailedLogs(state) {
  state.noNetValue ||= {};
  if (!skipNoNetValue || !fs.existsSync(logDir)) return state;

  let changed = false;
  for (const file of fs.readdirSync(logDir)) {
    if (!/^failed-products-.*\.csv$/.test(file)) continue;
    const rows = parseCsv(fs.readFileSync(path.join(logDir, file), "utf8"));
    for (const row of rows) {
      if (!row.productUrl || !isNoNetValueLikeError(row.errorMessage)) continue;
      if (state.noNetValue[row.productUrl]) continue;
      state.noNetValue[row.productUrl] = {
        name: row.productName || "",
        id: row.productUrl.split("/").filter(Boolean).pop() || "",
        detail: row.errorMessage,
        confirmations: 1,
        confirmed: noNetValueConfirmations <= 1,
        markedAt: row.time || "",
        source: file
      };
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(resumePath, JSON.stringify(state, null, 2), "utf8");
  }

  return state;
}

function hasRequiredMetadata(metadata) {
  return [
    "primaryStrategy",
    "secondaryStrategy",
    "operationStatus",
    "recordNumber",
    "inceptionDate",
    "privateManager",
    "companyManagementScale",
    "fundManager"
  ].every((key) => Object.prototype.hasOwnProperty.call(metadata, key));
}

function latestRowDate(rows) {
  return rows.map((row) => row.date).filter(Boolean).sort().at(-1) || "";
}

function mergeRows(existingRows, newRows) {
  const merged = new Map();
  for (const row of existingRows) {
    if (row?.date) merged.set(row.date, row);
  }
  for (const row of newRows) {
    if (row?.date) merged.set(row.date, row);
  }
  return [...merged.values()].sort((a, b) => b.date.localeCompare(a.date));
}

function writeCsv(filePath, rows) {
  fs.writeFileSync(filePath, rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n", "utf8");
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

function safeName(value) {
  return String(value || "untitled")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 120)
    .trim();
}

function log(status, product, detail, extra = {}) {
  const row = [
    new Date().toISOString(),
    status,
    product.name,
    product.url,
    detail,
    extra.errorName || "",
    extra.screenshot || "",
    extra.jsonPath || ""
  ];
  logRows.push(row);
  appendCsv(liveRunLogPath, row);

  if (status === "failed") {
    appendCsv(liveFailedLogPath, [
      row[0],
      product.name,
      product.url,
      extra.errorName || "",
      detail,
      extra.screenshot || "",
      extra.jsonPath || ""
    ]);
  }
}

function createProgress() {
  const state = {
    page: 1,
    discovered: 0,
    completed: 0,
    ok: 0,
    failed: 0,
    skipped: 0,
    active: new Set(),
    pageTotal: 0,
    targetProducts: 0,
    totalItems: 0,
    pageSize: 0,
    lastLineLength: 0,
    lastNotifiedPage: 0,
    startedAt: Date.now()
  };

  const enabled = progressEnabled && Boolean(process.stdout.isTTY);
  const formatLine = () => {
    const pageTarget = resolvePageTarget(state.pageTotal);
    const usePageProgress = !state.targetProducts && !maxProducts && pageTarget > 0;
    const total = usePageProgress ? pageTarget : state.targetProducts || maxProducts || Math.max(state.discovered, state.completed + state.active.size, 1);
    const completed = usePageProgress ? Math.min(state.page, total) : state.completed;
    const width = 20;
    const ratio = Math.min(1, completed / total);
    const filled = Math.floor(width * ratio);
    const bar = `${"#".repeat(filled)}${".".repeat(width - filled)}`;
    const percent = Math.floor(ratio * 100);
    const elapsedSeconds = Math.max(0, Math.round((Date.now() - state.startedAt) / 1000));
    const avgBase = completed > 0 ? completed : 0;
    const avgSeconds = avgBase ? elapsedSeconds / avgBase : 0;
    const remaining = Math.max(0, total - completed);
    const etaSeconds = avgBase ? Math.round(avgSeconds * remaining) : 0;
    const current = [...state.active].slice(-2).join(" | ");
    const totalLabel = usePageProgress || maxProducts || state.targetProducts ? String(total) : `${total}?`;
    const avgUnit = usePageProgress ? "page" : "item";
    const line = [
      `[${bar}]`,
      `${completed}/${totalLabel}`,
      `${percent}%`,
      `elapsed=${formatDuration(elapsedSeconds)}`,
      `eta=${avgBase ? formatDuration(etaSeconds) : "--:--"}`,
      `avg=${avgBase ? `${avgSeconds.toFixed(1)}s/${avgUnit}` : "--"}`,
      `ok=${state.ok}`,
      `fail=${state.failed}`,
      `skip=${state.skipped}`,
      `active=${state.active.size}`,
      `page=${formatPageLabel(state)}`,
      usePageProgress ? `items=${state.completed}/${state.discovered || "?"}` : "",
      current ? `current=${truncate(current, 28)}` : ""
    ].filter(Boolean).join(" ");
    return line;
  };
  const render = () => {
    if (!enabled) return;
    const line = formatLine();
    const padded = line.padEnd(state.lastLineLength, " ");
    process.stdout.write(`\r${padded}`);
    state.lastLineLength = line.length;
  };
  const notifyPageProgress = () => {
    if (!progressNotifyUrl || state.page === state.lastNotifiedPage) return;
    state.lastNotifiedPage = state.page;
    notifyProgress(progressNotifyUrl, progressNotifyTitle, formatLine()).catch((error) => {
      console.error(`[notify] failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  return {
    setTarget(count) {
      state.targetProducts = Math.max(0, Number(count) || 0);
      render();
    },
    setPage(page, pagination = {}) {
      state.page = page;
      if (Number.isFinite(pagination.totalPages) && pagination.totalPages > 0) {
        state.pageTotal = pagination.totalPages;
      } else if (Number.isFinite(pagination.visibleLastPage) && pagination.visibleLastPage > 0) {
        state.pageTotal = pagination.visibleLastPage;
      }
      if (Number.isFinite(pagination.totalItems) && pagination.totalItems > 0) {
        state.totalItems = pagination.totalItems;
      }
      if (Number.isFinite(pagination.pageSize) && pagination.pageSize > 0) {
        state.pageSize = pagination.pageSize;
      }
      render();
      notifyPageProgress();
    },
    addDiscovered(count) {
      state.discovered += count;
      render();
    },
    start(name) {
      state.active.add(name || "unknown");
      render();
    },
    done(name, ok) {
      state.active.delete(name || "unknown");
      state.completed += 1;
      if (ok) state.ok += 1;
      else state.failed += 1;
      render();
    },
    skipped() {
      state.completed += 1;
      state.skipped += 1;
      render();
    },
    finish() {
      if (!enabled) {
        console.log(`[summary] processed=${state.completed} ok=${state.ok} failed=${state.failed} skipped=${state.skipped} elapsed=${formatDuration(Math.round((Date.now() - state.startedAt) / 1000))}`);
        return;
      }
      render();
      process.stdout.write("\n");
      console.log(`[summary] processed=${state.completed} ok=${state.ok} failed=${state.failed} skipped=${state.skipped} elapsed=${formatDuration(Math.round((Date.now() - state.startedAt) / 1000))}`);
    }
  };
}

function resolvePageTarget(totalPages) {
  const normalizedTotal = Number.isFinite(totalPages) && totalPages > 0 ? totalPages : 0;
  if (maxPages > 0 && normalizedTotal > 0) return Math.min(maxPages, normalizedTotal);
  if (maxPages > 0) return maxPages;
  return normalizedTotal;
}

function formatPageLabel(state) {
  const pageTarget = resolvePageTarget(state.pageTotal);
  if (pageTarget > 0) return `${state.page}/${pageTarget}`;
  return String(state.page);
}

async function notifyProgress(baseUrl, title, body) {
  const cleanBase = String(baseUrl || "").replace(/\/+$/, "");
  if (!cleanBase) return;
  const url = new URL(`${cleanBase}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`);
  url.searchParams.set("group", "fof99");
  url.searchParams.set("isArchive", "1");
  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(rest)}`;
  return `${pad2(minutes)}:${pad2(rest)}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
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
