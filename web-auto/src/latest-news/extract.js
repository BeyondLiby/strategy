import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureAlphaPaiLoggedIn } from "../auth/alpha-pai-login.js";
import { launchAlphaPaiContext } from "../auth/persistent-context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const config = readJson(path.join(rootDir, "config/latest-extraction.json"));
const outputRoot = path.join(rootDir, config.outputDir || "output/latest-news");
const csvPath = path.join(rootDir, config.inputCsv || "data/stocks.csv");
const headless = process.env.HEADLESS !== "false" && config.browser?.headless !== false;
const args = parseArgs(process.argv.slice(2));
const dateWindow = buildDateWindow(args);
const concurrency = getConcurrency(args);

fs.mkdirSync(outputRoot, { recursive: true });
if (dateWindow) {
  console.log(`Using latest-news date window: ${formatDate(dateWindow.from)} to ${formatDate(dateWindow.to)}`);
}

const stocks = getRequestedStocks();
const context = await launchAlphaPaiContext(config, rootDir, { headless });

context.setDefaultTimeout(30_000);
await context.grantPermissions(["clipboard-read", "clipboard-write"], {
  origin: config.alphaPai?.origin || "https://alphapai-web.rabyte.cn"
}).catch(() => {});

const logRows = [["time", "code", "name", "status", "detail", "file"]];
let okCount = 0;
let failedCount = 0;

try {
  printRunHeader(stocks.length, concurrency);
  await runStocks(stocks, concurrency);
  clearProgressLine();
  console.log(`Done. ok=${okCount}, failed=${failedCount}, log=${path.join(outputRoot, "run-log.csv")}`);
} finally {
  writeCsv(path.join(outputRoot, "run-log.csv"), logRows);
  await context.close().catch(() => {});
}

async function runStocks(stocks, workerCount) {
  let nextIndex = 0;
  let completed = 0;
  const workers = Array.from({ length: Math.min(workerCount, stocks.length) }, async (_, workerIndex) => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= stocks.length) return;

      const stock = stocks[index];
      renderProgress(completed, stocks.length, `worker ${workerIndex + 1} running ${stock.code}`);
      const result = await extractOneMulti(context, stock);

      completed += 1;
      if (result.status === "ok" || result.status === "partial") okCount += 1;
      if (result.status === "failed") failedCount += 1;
      renderProgress(completed, stocks.length, `${stock.code} ${result.status}`);
      printStockResult(completed, stocks.length, stock, result);
    }
  });

  await Promise.all(workers);
}

async function extractOne(context, stock) {
  const page = await context.newPage();
  const stockDir = path.join(outputRoot, safeName(`${stock.code}_${stock.name}`));
  fs.mkdirSync(stockDir, { recursive: true });

  try {
    const stockUrl = stock.url || stockUrlFromCode(stock);
    await gotoReady(page, stockUrl);

    await ensureAlphaPaiLoggedIn(page, config, rootDir, { returnUrl: stockUrl, headless });

    await page.screenshot({ path: path.join(stockDir, "01-stock.png"), fullPage: true });
    await dismissGuides(page);
    await settle(page);

    const allCandidates = await collectLatestCandidates(page, config);
    const candidates = filterCandidatesByDate(allCandidates, dateWindow);
    fs.writeFileSync(
      path.join(stockDir, "latest-candidates.json"),
      JSON.stringify(candidates, null, 2),
      "utf8"
    );

    if (!candidates.length) {
      const dateHint = dateWindow ? ` 日期范围：${formatDate(dateWindow.from)} 到 ${formatDate(dateWindow.to)}。` : "";
      throw new Error(`没有从最新跟踪列表中识别出符合条件的资讯行。${dateHint}`);
    }

    const latest = await openFirstNavigableCandidate(page, candidates);
    await settle(page);

    const embeddedArticle = articleFromCandidate(stock, latest);
    const hasUsableDetail = await waitForUsableDetailPage(page);
    const usedEmbeddedArticle = Boolean(embeddedArticle && !hasUsableDetail);

    if (usedEmbeddedArticle) {
      await renderEmbeddedArticle(page, embeddedArticle);
    } else if (!hasUsableDetail) {
      throw new Error(`点击最新资讯后未打开有效详情：${page.url()}`);
    }

    await page.screenshot({ path: path.join(stockDir, "02-detail.png"), fullPage: true });
    const extracted = usedEmbeddedArticle ? embeddedArticle : await extractArticle(page);
    const copied = usedEmbeddedArticle ? "" : await tryCopyArticle(page);
    const finalText = copied || extracted.text;
    const articleTitle = isSiteTitle(extracted.title) ? latest.title : extracted.title;

    const datePart = normalizeDateForFile(latest.date);
    const baseName = `${datePart}_${safeName(stock.code)}_${safeName(stock.name)}_${safeName(articleTitle || "latest")}`;
    const textPath = path.join(stockDir, `${baseName}.txt`);
    const jsonPath = path.join(stockDir, `${baseName}.json`);
    const pdfPath = path.join(stockDir, `${baseName}.pdf`);

    fs.writeFileSync(textPath, finalText || extracted.text || "", "utf8");
    fs.writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          stock,
          latest,
          detailUrl: detailUrlForLog(page, latest),
          pageUrl: page.url(),
          title: articleTitle,
          source: extracted.source,
          date: extracted.date,
          usedClipboardCopy: Boolean(copied),
          usedEmbeddedArticle,
          textFile: textPath,
          pdfFile: pdfPath
        },
        null,
        2
      ),
      "utf8"
    );

    await page.emulateMedia({ media: "screen" });
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    const pdfSize = await page.evaluate(() => ({
      width: Math.ceil(Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, window.innerWidth)),
      height: Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, window.innerHeight))
    })).catch(() => page.viewportSize() || { width: 1440, height: 1200 });
    await page.pdf({
      path: pdfPath,
      width: `${pdfSize.width}px`,
      height: `${pdfSize.height}px`,
      printBackground: true
    });

    log(stock, "ok", page.url(), textPath);
    return { status: "ok", file: textPath, detail: page.url() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(stock, "failed", message, "");
    await page.screenshot({ path: path.join(stockDir, "failed.png"), fullPage: true }).catch(() => {});
    return { status: "failed", message };
  } finally {
    await page.close().catch(() => {});
  }
}

async function extractOneMulti(context, stock) {
  const page = await context.newPage();
  const stockDir = path.join(outputRoot, safeName(`${stock.code}_${stock.name}`));

  try {
    resetOutputDir(stockDir);
    const stockUrl = stock.url || stockUrlFromCode(stock);
    await gotoReady(page, stockUrl);

    await ensureAlphaPaiLoggedIn(page, config, rootDir, { returnUrl: stockUrl, headless });

    await page.screenshot({ path: path.join(stockDir, "01-stock.png"), fullPage: true });
    await dismissGuides(page);
    await settle(page);

    const allCandidates = await collectLatestCandidates(page, config);
    const candidates = filterCandidatesByDate(allCandidates, dateWindow);
    fs.writeFileSync(path.join(stockDir, "latest-candidates.json"), JSON.stringify(candidates, null, 2), "utf8");

    if (!candidates.length) {
      const dateHint = dateWindow ? ` 日期范围：${formatDate(dateWindow.from)} 到 ${formatDate(dateWindow.to)}。` : "";
      throw new Error(`没有从最新跟踪列表中识别出符合条件的资讯行。${dateHint}`);
    }

    const selectedCandidates = selectCandidatesForDownload(candidates);
    const results = [];
    for (let index = 0; index < selectedCandidates.length; index += 1) {
      const candidate = selectedCandidates[index];
      try {
        if (index > 0) {
          await gotoReady(page, stockUrl);
          await dismissGuides(page);
          await settle(page);
        }
        results.push(await extractCandidateArticle(page, stock, stockDir, candidate, index + 1));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(stock, "failed", `${candidate.date} ${candidate.title}: ${message}`, "");
        results.push({ status: "failed", message, candidate });
      }
    }

    const okResults = results.filter((result) => result.status === "ok");
    const failedResults = results.filter((result) => result.status === "failed");
    if (!okResults.length) {
      throw new Error(`${failedResults.length} candidates matched but none were exported.`);
    }

    return {
      status: failedResults.length ? "partial" : "ok",
      file: okResults[0].file,
      detail: `${okResults.length}/${selectedCandidates.length} articles exported`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(stock, "failed", message, "");
    await page.screenshot({ path: path.join(stockDir, "failed.png"), fullPage: true }).catch(() => {});
    return { status: "failed", message };
  } finally {
    await page.close().catch(() => {});
  }
}

async function extractCandidateArticle(page, stock, stockDir, candidate, sequence) {
  const openedCandidate = await openCandidate(page, candidate);
  await settle(page);

  const embeddedArticle = articleFromCandidate(stock, openedCandidate);
  const hasUsableDetail = await waitForUsableDetailPage(page);
  const usedEmbeddedArticle = Boolean(embeddedArticle && !hasUsableDetail);

  if (usedEmbeddedArticle) {
    await renderEmbeddedArticle(page, embeddedArticle);
  } else if (!hasUsableDetail) {
    throw new Error(`点击资讯后未打开有效详情：${page.url()}`);
  }

  const detailImageName = `${String(sequence + 1).padStart(2, "0")}-detail.png`;
  await page.screenshot({ path: path.join(stockDir, detailImageName), fullPage: true });

  const extracted = usedEmbeddedArticle ? embeddedArticle : await extractArticle(page);
  const copied = usedEmbeddedArticle ? "" : await tryCopyArticle(page);
  const finalText = copied || extracted.text;
  const articleTitle = isSiteTitle(extracted.title) ? openedCandidate.title : extracted.title;

  const datePart = normalizeDateForFile(openedCandidate.date);
  const baseName = uniqueBaseName(stockDir, `${datePart}_${safeName(stock.code)}_${safeName(stock.name)}_${safeName(articleTitle || "latest")}`);
  const textPath = path.join(stockDir, `${baseName}.txt`);
  const jsonPath = path.join(stockDir, `${baseName}.json`);
  const pdfPath = path.join(stockDir, `${baseName}.pdf`);

  fs.writeFileSync(textPath, finalText || extracted.text || "", "utf8");
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        stock,
        latest: openedCandidate,
        detailUrl: detailUrlForLog(page, openedCandidate),
        pageUrl: page.url(),
        title: articleTitle,
        source: extracted.source,
        date: extracted.date,
        usedClipboardCopy: Boolean(copied),
        usedEmbeddedArticle,
        textFile: textPath,
        pdfFile: pdfPath
      },
      null,
      2
    ),
    "utf8"
  );

  await writePagePdf(page, pdfPath);
  log(stock, "ok", page.url(), textPath);
  return { status: "ok", file: textPath, candidate: openedCandidate };
}

async function collectLatestCandidates(page, config) {
  return page.evaluate((config) => {
    const selectors = config.selectors || {};
    const rules = config.candidateRules || {};
    const vueItems = collectVueListItems();
    if (vueItems.length) return vueItems;

    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };

    const textOf = (element) => (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    const dateRegex = /^(\d{1,2}\s*小时前|昨天|前天|\d{2}-\d{2}|\d{4}-\d{2}-\d{2})$/;
    const dateNodes = [...document.querySelectorAll("span,div")]
      .filter(visible)
      .map((element) => ({ element, text: textOf(element), box: element.getBoundingClientRect() }))
      .filter((item) => dateRegex.test(item.text) && item.box.left > 250 && item.box.left < window.innerWidth - 250);

    const candidates = [];
      const allTextNodes = [...document.querySelectorAll("a,span,div")]
      .filter(visible)
      .map((element) => ({ element, text: textOf(element), box: element.getBoundingClientRect() }))
      .filter((item) => item.text && item.text.length > 3);

    for (const dateNode of dateNodes) {
      if (dateNode.box.left < 320 || dateNode.box.left > 390) continue;
      const sameRow = allTextNodes
        .filter((item) => Math.abs(item.box.top - dateNode.box.top) < 12 && item.box.left > 380 && item.box.left < 1050)
        .sort((a, b) => a.box.left - b.box.left);

      const titleNode = sameRow.find((item) => {
        if (item.text === dateNode.text) return false;
        if (/^(全部|外资观点|精选点评|纪要|研报)$/.test(item.text)) return false;
        return item.text.length >= 8;
      });

      if (!titleNode) continue;
      const title = titleNode.text.replace(/\s+/g, " ").trim();
      const sourceNode = sameRow.find((item) => item.box.left > titleNode.box.right && item.text.length <= 20);
      candidates.push({
        date: normalizeDisplayDate(dateNode.text),
        dateText: dateNode.text,
        title,
        source: sourceNode?.text || "",
        clickX: Math.round(titleNode.box.left + Math.min(titleNode.box.width / 2, 240)),
        clickY: Math.round(titleNode.box.top + titleNode.box.height / 2),
        y: Math.round(dateNode.box.top)
      });
    }

    const unique = [];
    const seen = new Set();
    for (const item of candidates) {
      const key = `${item.date}|${item.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
    }

    return unique.sort((a, b) => compareDisplayDate(b.date, a.date) || a.y - b.y);

    function compareDisplayDate(left, right) {
      return toSortable(left).localeCompare(toSortable(right));
    }

    function toSortable(value) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
      const year = new Date().getFullYear();
      return `${year}-${value}`;
    }

    function normalizeDisplayDate(value, time) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
      if (/^\d{2}-\d{2}$/.test(value)) return value;

      const fromTime = dateFromTimestamp(time);
      if (fromTime) return fromTime;

      const hoursAgo = String(value || "").match(/^(\d{1,2})\s*小时前$/);
      const date = new Date();
      if (hoursAgo) {
        date.setHours(date.getHours() - Number(hoursAgo[1]));
      } else if (value === "昨天") {
        date.setDate(date.getDate() - 1);
      } else if (value === "前天") {
        date.setDate(date.getDate() - 2);
      } else {
        return value;
      }

      return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    }

    function dateFromTimestamp(time) {
      const match = String(time || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
      return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
    }

    function collectVueListItems() {
      const lists = [...document.querySelectorAll(selectors.candidateLists || ".recent-tracking, .recent-data-list")]
        .filter((element) => element.closest(".left-part"))
        .map((element) => element.__vue__?._data?.list)
        .filter((list) => Array.isArray(list) && list.length);

      const list = lists[0] || [];
      return list
        .filter((item) => item?.id && item?.dateText)
        .map((item, index) => ({
          id: item.id,
          type: item.type,
          typeName: rules.typeNames?.[String(item.type)] || "未知",
          time: item.time,
          date: normalizeDisplayDate(item.dateText, item.time),
          dateText: item.dateText,
          title: item.title || item.commentCn || item.commentEn || "untitled",
          bodyText: item.commentCn || item.commentEn || "",
          source: item.institutionText || "",
          detailUrl: `/reading/home/point/detail?articleId=${encodeURIComponent(item.id)}`,
          clickX: 420,
          clickY: 235 + index * 34,
          y: 235 + index * 34
        }))
        .sort((a, b) => compareDisplayDate(b.date, a.date) || candidateTypeScore(b, rules) - candidateTypeScore(a, rules) || a.y - b.y);
    }

    function candidateTypeScore(candidate, rules) {
      const preferTypes = rules.preferTypes || [39];
      const summaryTypes = rules.summaryTypes || [82];
      if (preferTypes.includes(candidate.type)) return 2;
      if (summaryTypes.includes(candidate.type)) return 0;
      return 1;
    }
  }, config);
}

async function openFirstNavigableCandidate(page, candidates) {
  const listUrl = page.url();
  const latestDate = candidates[0].date;
  const sameDateCandidates = candidates
    .filter((candidate) => candidate.date === latestDate)
    .sort((a, b) => candidatePreferenceScore(b) - candidatePreferenceScore(a));

  for (const candidate of sameDateCandidates) {
    if (candidateHasEmbeddedArticle(candidate)) return candidate;

    await page.keyboard.press("Escape").catch(() => {});
    await page.evaluate(() => document.querySelectorAll(".el-popover").forEach((element) => element.remove())).catch(() => {});
    const clickedInDom = await clickCandidateInPage(page, candidate);
    if (!clickedInDom) {
      await clickCandidateByCoordinates(page, candidate);
    }
    await page.waitForTimeout(900);

    if (!page.url().includes(config.alphaPai?.detailPath || "/reading/home/point/detail")) {
      if (!clickedInDom) {
        await clickCandidateByCoordinates(page, { ...candidate, clickX: candidate.clickX + 80 });
      }
      await page.waitForTimeout(700);
    }

    if (await waitForUsableDetailPage(page)) {
      return candidate;
    }

    if (page.url().includes(config.alphaPai?.detailPath || "/reading/home/point/detail")) {
      await gotoReady(page, listUrl);
      await dismissGuides(page);
      await settle(page);
    }

    if (!clickedInDom && candidate.detailUrl) {
      await gotoReady(page, new URL(candidate.detailUrl, config.alphaPai?.origin || "https://alphapai-web.rabyte.cn").href);
      if (await waitForUsableDetailPage(page)) return candidate;

      if (page.url().includes(config.alphaPai?.detailPath || "/reading/home/point/detail")) {
        await gotoReady(page, listUrl);
        await dismissGuides(page);
        await settle(page);
      }
    }
  }

  throw new Error(`最新日期 ${latestDate} 的候选资讯均未进入详情页。`);
}

async function openCandidate(page, candidate) {
  if (candidateHasEmbeddedArticle(candidate)) return candidate;

  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => document.querySelectorAll(".el-popover").forEach((element) => element.remove())).catch(() => {});

  const clickedInDom = await clickCandidateInPage(page, candidate);
  if (!clickedInDom) {
    await clickCandidateByCoordinates(page, candidate);
  }
  await page.waitForTimeout(900);

  if (!page.url().includes(config.alphaPai?.detailPath || "/reading/home/point/detail")) {
    if (!clickedInDom) {
      await clickCandidateByCoordinates(page, { ...candidate, clickX: candidate.clickX + 80 });
    }
    await page.waitForTimeout(700);
  }

  if (await waitForUsableDetailPage(page)) return candidate;

  if (candidate.detailUrl) {
    await gotoReady(page, new URL(candidate.detailUrl, config.alphaPai?.origin || "https://alphapai-web.rabyte.cn").href);
    if (await waitForUsableDetailPage(page)) return candidate;
  }

  throw new Error(`候选资讯未进入详情页：${candidate.date} ${candidate.title || candidate.id}`);
}

async function clickCandidateInPage(page, candidate) {
  return page.evaluate((candidate) => {
    const textOf = (element) => (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    const title = String(candidate.title || "").replace(/\s+/g, " ").trim();
    const anchors = title
      ? [title, title.slice(0, 24), title.slice(0, 12)].filter((value) => value.length >= 6)
      : [];

    if (candidate.id) {
      const lists = [...document.querySelectorAll(".left-part .recent-tracking, .left-part .recent-data-list")]
        .map((element) => element.__vue__)
        .filter((vm) => Array.isArray(vm?.list));
      const listMatch = lists
        .map((vm) => ({ vm, index: vm.list.findIndex((item) => item?.id === candidate.id) }))
        .find((match) => match.index >= 0);

      const rowElements = [...document.querySelectorAll(".left-part .data-item")];
      const row = rowElements.find((element) => textOf(element).includes(title.slice(0, 12))) || rowElements[listMatch?.index ?? 0] || document.body;
      const detailVm = row.closest(".data-list")?.__vue__ || document.querySelector(".left-part .data-list")?.__vue__;
      const item = listMatch ? listMatch.vm.list[listMatch.index] : null;
      if (item && typeof detailVm?.goDetail === "function") {
        detailVm.goDetail(item, listMatch.index, { target: row });
        return true;
      }
    }

    const target = [...document.querySelectorAll("a,span,div")]
      .filter(visible)
      .filter((element) => {
        const text = textOf(element);
        return anchors.some((anchor) => text.includes(anchor) || anchor.includes(text));
      })
      .sort((a, b) => {
        const aBox = a.getBoundingClientRect();
        const bBox = b.getBoundingClientRect();
        return textOf(a).length - textOf(b).length || (aBox.width * aBox.height) - (bBox.width * bBox.height);
      })[0];

    if (!target) return false;

    const clickable = target.closest("a,button,[role='button'],.data-item,.info-wrap,.title,.cursor-pointer,.point-item,.item,.list-item") || target;
    clickable.scrollIntoView({ block: "center", inline: "nearest" });
    clickable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
    clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    clickable.click();
    return true;
  }, candidate).catch(() => false);
}

async function clickCandidateByCoordinates(page, candidate) {
  const viewport = page.viewportSize() || { width: 1440, height: 1200 };
  let clickY = candidate.clickY;

  if (clickY > viewport.height - 40 || clickY < 40) {
    const scrollY = Math.max(0, candidate.clickY - Math.round(viewport.height / 2));
    await page.evaluate((scrollY) => window.scrollTo(0, scrollY), scrollY).catch(() => {});
    await page.waitForTimeout(300);
    clickY = candidate.clickY - scrollY;
  }

  const clickX = Math.min(Math.max(candidate.clickX, 20), viewport.width - 20);
  const safeY = Math.min(Math.max(clickY, 40), viewport.height - 40);
  await page.mouse.click(clickX, safeY);
}

async function isUsableDetailPage(page) {
  const modalDetail = await page.evaluate(() => {
    const vm = document.querySelector(".left-part .data-list")?.__vue__;
    return Boolean(vm?.detailVisible && vm?.itemData?.content);
  }).catch(() => false);
  if (modalDetail) return true;

  if (!page.url().includes(config.alphaPai?.detailPath || "/reading/home/point/detail")) return false;

  const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  if (/Invalid Date|内容已删除|无法查看/.test(bodyText)) return false;
  return true;
}

async function waitForUsableDetailPage(page, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUsableDetailPage(page)) return true;
    await page.waitForTimeout(300);
  }

  return false;
}

function detailUrlForLog(page, latest) {
  if (page.url().includes(config.alphaPai?.detailPath || "/reading/home/point/detail")) return page.url();
  if (latest.detailUrl) {
    return new URL(latest.detailUrl, config.alphaPai?.origin || "https://alphapai-web.rabyte.cn").href;
  }

  return page.url();
}

function candidateHasEmbeddedArticle(candidate) {
  return normalizeEmbeddedText(candidate?.bodyText).length > 80;
}

function articleFromCandidate(stock, candidate) {
  const text = normalizeEmbeddedText(candidate?.bodyText);
  if (!text) return null;

  return {
    title: compactArticleTitle(candidate?.title, text, stock),
    text,
    date: candidate.time || candidate.date || "",
    source: candidate.source || candidate.typeName || ""
  };
}

async function renderEmbeddedArticle(page, article) {
  await page.setContent(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <style>
    body { margin: 0; background: #f5f6f8; color: #111827; font-family: Arial, "Microsoft YaHei", sans-serif; }
    main { max-width: 980px; margin: 32px auto; padding: 36px 44px; background: #fff; border-radius: 8px; }
    h1 { margin: 0 0 12px; font-size: 28px; line-height: 1.25; }
    .meta { color: #6b7280; font-size: 14px; margin-bottom: 28px; }
    .body { white-space: pre-wrap; font-size: 17px; line-height: 1.85; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(article.title)}</h1>
    <div class="meta">${escapeHtml([article.source, article.date].filter(Boolean).join(" · "))}</div>
    <div class="body">${escapeHtml(article.text)}</div>
  </main>
</body>
</html>`, { waitUntil: "domcontentloaded" });
}

function normalizeEmbeddedText(value) {
  return String(value || "")
    .replace(/\\n/g, "\n")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function compactArticleTitle(title, bodyText, stock) {
  const cleanTitle = String(title || "").replace(/\s+/g, " ").trim();
  const cleanBody = normalizeEmbeddedText(bodyText).replace(/\s+/g, " ").trim();
  if (cleanTitle && cleanTitle.length <= 120 && cleanTitle !== cleanBody) return cleanTitle;

  const firstLine = normalizeEmbeddedText(bodyText).split(/\n+/).find(Boolean) || `${stock.code} latest`;
  return firstLine.replace(/\s+/g, " ").slice(0, 100);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function filterCandidatesByDate(candidates, window) {
  if (!window) return candidates;
  return candidates.filter((candidate) => {
    const candidateDate = candidateDateForFilter(candidate);
    return candidateDate >= window.from && candidateDate <= window.to;
  });
}

function candidateDateForFilter(candidate) {
  const fullDate = String(candidate.dateText || candidate.time || "").match(/\d{4}-\d{2}-\d{2}/)?.[0];
  return parseDateArg(fullDate || candidate.date);
}

function selectCandidatesForDownload(candidates) {
  if (dateWindow) return candidates;
  const latestDate = candidates[0]?.date;
  return candidates.filter((candidate) => candidate.date === latestDate);
}

function resetOutputDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

function uniqueBaseName(dirPath, baseName) {
  let candidate = baseName;
  let index = 2;
  while (
    fs.existsSync(path.join(dirPath, `${candidate}.txt`)) ||
    fs.existsSync(path.join(dirPath, `${candidate}.json`)) ||
    fs.existsSync(path.join(dirPath, `${candidate}.pdf`))
  ) {
    candidate = `${baseName}_${index}`;
    index += 1;
  }
  return candidate;
}

async function writePagePdf(page, pdfPath) {
  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  const pdfSize = await page.evaluate(() => ({
    width: Math.ceil(Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, window.innerWidth)),
    height: Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, window.innerHeight))
  })).catch(() => page.viewportSize() || { width: 1440, height: 1200 });
  await page.pdf({
    path: pdfPath,
    width: `${pdfSize.width}px`,
    height: `${pdfSize.height}px`,
    printBackground: true
  });
}

function buildDateWindow(args) {
  if (args.date) {
    const date = parseDateArg(args.date);
    return { from: date, to: date };
  }

  if (args.from || args.to) {
    const from = parseDateArg(args.from || args.to);
    const to = parseDateArg(args.to || args.from);
    if (from > to) {
      throw new Error(`Invalid date range: --from ${args.from} is after --to ${args.to}`);
    }
    return { from, to };
  }

  const daysValue = args.days || args.day;
  if (daysValue) {
    const days = Number.parseInt(daysValue, 10);
    if (!Number.isFinite(days) || days < 1) {
      throw new Error(`Invalid --days value: ${daysValue}`);
    }

    const to = startOfDate(new Date());
    const from = addDays(to, -(days - 1));
    return { from, to };
  }

  return null;
}

function getConcurrency(args) {
  const rawValue = args.concurrency || config.concurrency?.stocks || 1;
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`Invalid --concurrency value: ${rawValue}`);
  }

  return Math.min(value, 4);
}

function parseDateArg(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Date value cannot be empty.");

  const normalized = raw.replaceAll("/", "-");
  const currentYear = new Date().getFullYear();
  let year = currentYear;
  let month;
  let day;

  const full = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const monthDay = normalized.match(/^(\d{1,2})-(\d{1,2})$/);
  const compact = normalized.match(/^(\d{3,4})$/);

  if (full) {
    year = Number(full[1]);
    month = Number(full[2]);
    day = Number(full[3]);
  } else if (monthDay) {
    month = Number(monthDay[1]);
    day = Number(monthDay[2]);
  } else if (compact) {
    month = Number(normalized.slice(0, -2));
    day = Number(normalized.slice(-2));
  } else {
    throw new Error(`Invalid date format: ${value}. Use YYYY-MM-DD, MM-DD, or MDD.`);
  }

  const date = startOfDate(new Date(year, month - 1, day));
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`Invalid date value: ${value}`);
  }

  return date;
}

function startOfDate(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return startOfDate(result);
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isSummaryTitle(title) {
  return /^\s*\[(维持|跟踪|上调|下调|买入|增持|中性|卖出)\]/.test(title || "");
}

function isSiteTitle(title) {
  return !title || /^(讯兔科技|Alpha派|首页)$/.test(String(title).trim());
}

function candidatePreferenceScore(candidate) {
  const preferTypes = config.candidateRules?.preferTypes || [39];
  const summaryTypes = config.candidateRules?.summaryTypes || [82];
  if (preferTypes.includes(candidate.type)) return 20;
  if (summaryTypes.includes(candidate.type)) return isSummaryTitle(candidate.title) ? 0 : 5;
  return 10;
}

function typeName(type) {
  return config.candidateRules?.typeNames?.[String(type)] || "未知";
}

async function extractArticle(page) {
  return page.evaluate((selectors) => {
    const textOf = (element) => (element?.innerText || element?.textContent || "").replace(/[ \t]+\n/g, "\n").trim();
    const modalVm = document.querySelector(".left-part .data-list")?.__vue__;
    const modalData = modalVm?.detailVisible ? modalVm.itemData : null;
    if (modalData?.content) {
      const sourceParts = [
        modalData.institution,
        modalData.teamName,
        ...(Array.isArray(modalData.industry) ? modalData.industry.map((item) => item?.name).filter(Boolean) : [])
      ].filter(Boolean);

      return {
        title: modalData.title || "latest",
        text: modalData.content,
        date: modalData.time || "",
        source: sourceParts.join(" ")
      };
    }

    const selector = (key, fallback) => selectors?.[key] || fallback;
    const title =
      textOf(document.querySelector(selector("detailTitle", ".title-box--en .title, .title-box--zh, h1"))) ||
      document.title.replace(/-Alpha派$/, "").trim();

    const modules = [...document.querySelectorAll(selector("detailBodyModules", ".us-stock-abstract__module"))]
      .map((element) => textOf(element))
      .filter((text) => text.length > 20);

    const body = modules.length
      ? modules.join("\n\n")
      : textOf(document.querySelector(selector("detailBodyFallback", ".article-section, .detail-layout, .article"))) || textOf(document.body);

    const lines = body.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const dateLine = lines.find((line) => /\b20\d{2}-\d{2}-\d{2}\b/.test(line)) || "";
    const sourceLine = textOf(document.querySelector(selector("detailSource", ".bottom-box .left"))) || lines.find((line) => /公司研究|医药生物|银行|证券|分析师/.test(line)) || "";
    return {
      title,
      text: body,
      date: dateLine,
      source: sourceLine
    };
  }, config.selectors || {});
}

async function tryCopyArticle(page) {
  const before = await page.evaluate(() => navigator.clipboard?.readText?.().catch(() => "")).catch(() => "");
  const copyTargets = config.selectors?.copyButtons || [
    "[aria-label*='复制']",
    "[title*='复制']",
    ".anticon-copy",
    "button:has-text('复制')",
    "text=复制"
  ];

  for (const selector of copyTargets) {
    const target = page.locator(selector).first();
    if (!(await target.count())) continue;
    await target.click().catch(() => {});
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => navigator.clipboard?.readText?.().catch(() => "")).catch(() => "");
    if (after && after !== before && after.length > 100) return after;
  }

  return "";
}

async function clickIfVisible(page, selector) {
  const target = page.locator(selector).first();
  if (await target.count()) {
    await target.click().catch(() => {});
  }
}

async function dismissGuides(page) {
  await page.evaluate((selectors) => {
    document.querySelectorAll(selectors.guideLayers || ".cp-guide-activity, .el-popover").forEach((element) => element.remove());
  }, config.selectors || {}).catch(() => {});

  const guideButtons = [
    "text=知道了",
    "button:has-text('知道了')",
    ".cp-guide-activity"
  ];

  for (const selector of guideButtons) {
    const target = page.locator(selector).first();
    if (!(await target.count())) continue;
    await target.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function waitForInteractiveLogin(page, returnUrl) {
  console.log("检测到登录页。请在打开的 Edge 窗口中完成登录，脚本会等待最多 5 分钟后继续。");
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    if (!page.url().includes("/login")) {
      await gotoReady(page, returnUrl);
      return;
    }
  }

  throw new Error("等待登录超时。");
}

async function gotoReady(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await settle(page);
}

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.locator("body").waitFor({ state: "visible" });
  await page.waitForTimeout(1200);
}

function getRequestedStocks() {
  if (args.url || args.code || args.name) {
    return [{
      code: args.code || "UNKNOWN",
      name: args.name || args.code || "UNKNOWN",
      url: args.url || ""
    }];
  }

  return readCsv(csvPath).map((row) => ({
    code: row.code?.trim(),
    name: row.name?.trim(),
    url: row.url?.trim()
  })).filter((row) => row.code && row.name);
}

function parseArgs(args) {
  const allowed = new Set(["code", "name", "url", "date", "from", "to", "days", "day", "concurrency"]);
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument for extract: ${arg}`);
    }

    const equalsIndex = arg.indexOf("=");
    if (equalsIndex > 2) {
      const key = arg.slice(2, equalsIndex);
      if (!allowed.has(key)) throw new Error(`Unknown option: --${key}`);
      result[key] = arg.slice(equalsIndex + 1);
      continue;
    }

    const key = arg.slice(2);
    if (!allowed.has(key)) throw new Error(`Unknown option: --${key}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function stockUrlFromCode(stock) {
  return `${config.alphaPai?.origin || "https://alphapai-web.rabyte.cn"}${config.alphaPai?.stockPath || "/reading/home/stock"}?id=${encodeURIComponent(stock.code)}&name=${encodeURIComponent(stock.name)}`;
}

function normalizeDateForFile(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return `${new Date().getFullYear()}-${value}`;
}

function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  const headers = splitCsvLine(lines.shift() || "");
  return lines.map((line) => {
    const cells = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function splitCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === "\"" && quoted && next === "\"") {
      current += "\"";
      index += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current);
  return cells;
}

function writeCsv(filePath, rows) {
  fs.writeFileSync(filePath, rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n", "utf8");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function safeName(value) {
  return String(value || "untitled")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 120)
    .trim();
}

function log(stock, status, detail, file) {
  logRows.push([new Date().toISOString(), stock.code, stock.name, status, detail, file]);
}

function printRunHeader(total, concurrency) {
  console.log(`Stocks: ${total}; concurrency: ${concurrency}`);
}

function printStockResult(done, total, stock, result) {
  clearProgressLine();

  const percent = String(Math.round(done / total * 100)).padStart(3, " ");
  const prefix = `[${String(done).padStart(String(total).length, " ")}/${total} ${percent}%]`;
  const status = result.status;
  const detail = result.status === "ok" || result.status === "partial"
    ? `${result.detail || "exported"}; first=${path.basename(result.file || "")}`
    : shortFailureMessage(result.message || "");

  console.log(fitTerminalLine(`${prefix} ${stock.code} ${status} - ${detail}`));
}

function renderProgress(done, total, detail = "") {
  if (!total || !isInteractiveTerminal()) return;

  const width = 24;
  const ratio = done / total;
  const filled = Math.round(width * ratio);
  const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
  const percent = String(Math.round(ratio * 100)).padStart(3, " ");
  const line = fitTerminalLine(`Progress [${bar}] ${done}/${total} ${percent}% ${detail}`);

  process.stdout.write(`\r${line.padEnd(progressLineWidth())}`);
}

function clearProgressLine() {
  if (!isInteractiveTerminal()) return;
  process.stdout.write(`\r${" ".repeat(progressLineWidth())}\r`);
}

function isInteractiveTerminal() {
  return Boolean(process.stdout.isTTY) && process.env.CI !== "true";
}

function progressLineWidth() {
  return Math.max(60, Math.min(process.stdout.columns || 100, 120));
}

function fitTerminalLine(value) {
  const maxLength = progressLineWidth() - 2;
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function shortFailureMessage(message) {
  return String(message || "")
    .replace(/^没有从最新跟踪列表中识别出符合条件的资讯行。?\s*/, "no matching latest item. ")
    .replace(/^最新日期\s+(.+?)\s+的候选资讯均未进入详情页。?/, "latest $1 did not open detail")
    .replace(/^点击最新资讯后未打开有效详情：/, "invalid detail: ")
    .trim();
}
