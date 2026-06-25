import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const config = readJson(path.join(rootDir, "config/latest-extraction.json"));
const args = parseArgs(process.argv.slice(2));

const outputRoot = resolveProjectPath(args.input || config.outputDir || "output/latest-news");
const csvPath = resolveProjectPath(args.stocks || config.inputCsv || "data/stocks.csv");
const runLogPath = resolveProjectPath(args.runLog || path.join(config.outputDir || "output/latest-news", "run-log.csv"));
const reportPath = resolveProjectPath(args.output || path.join(config.outputDir || "output/latest-news", "watchlist-overnight-report.md"));
const inputPath = resolveProjectPath(args.dataOutput || path.join(config.outputDir || "output/latest-news", "watchlist-report-input.json"));
const summariesPath = resolveProjectPath(args.summariesOutput || path.join(config.outputDir || "output/latest-news", "watchlist-stock-summaries.json"));
const promptPath = resolveProjectPath(args.promptOutput || path.join(config.outputDir || "output/latest-news", "watchlist-report-prompt.md"));
const maxArticleChars = parsePositiveInt(args.maxArticleChars || "12000", "--max-article-chars");
const model = args.model || process.env.OPENAI_MODEL || "gpt-4.1-mini";
const shouldUseAi = !args.noAi && !args.dryRun && Boolean(process.env.OPENAI_API_KEY);

const watchlist = readCsv(csvPath).map((row) => ({
  code: row.code?.trim(),
  name: row.name?.trim(),
  url: row.url?.trim() || ""
})).filter((row) => row.code && row.name);

if (!watchlist.length) {
  throw new Error(`No watchlist stocks found in ${csvPath}`);
}

const runRows = fs.existsSync(runLogPath) ? readCsv(runLogPath) : [];
const okRowsByCode = groupOkRowsByCode(runRows);
const reportData = buildReportData(watchlist, okRowsByCode);

fs.mkdirSync(path.dirname(inputPath), { recursive: true });
fs.writeFileSync(inputPath, JSON.stringify(reportData, null, 2), "utf8");

const promptBundle = buildPromptBundle(reportData);
fs.writeFileSync(promptPath, promptBundle, "utf8");

if (!shouldUseAi) {
  console.log(`Prepared report input: ${inputPath}`);
  console.log(`Prepared AI prompt: ${promptPath}`);
  if (!process.env.OPENAI_API_KEY && !args.noAi && !args.dryRun) {
    console.log("OPENAI_API_KEY is not set, so no AI report was generated.");
  }
  process.exit(0);
}

const stockSummaries = [];
for (const stock of reportData.watchlist) {
  if (!stock.articles.length) {
    stockSummaries.push({
      code: stock.code,
      name: stock.name,
      hasNewInfo: false,
      articleCount: 0,
      direction: "无新增",
      overnightStatus: "本窗口未抓到新增资讯",
      keyChanges: [],
      detailedAnalysis: [],
      todayFocus: ["仅监控价格和成交量异动"],
      sourceNotes: []
    });
    continue;
  }

  const summaryText = await callOpenAi({
    model,
    system: stockSummarySystemPrompt(),
    user: stockSummaryUserPrompt(stock)
  });
  stockSummaries.push(parseJsonFromModel(summaryText, stock));
}

fs.writeFileSync(summariesPath, JSON.stringify(stockSummaries, null, 2), "utf8");

const finalReport = await callOpenAi({
  model,
  system: finalReportSystemPrompt(),
  user: finalReportUserPrompt(reportData, stockSummaries)
});

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, finalReport.trim() + "\n", "utf8");
console.log(`Wrote report: ${reportPath}`);
console.log(`Wrote stock summaries: ${summariesPath}`);
console.log(`Wrote report input: ${inputPath}`);

function buildReportData(stocks, okRowsByCode) {
  const items = stocks.map((stock) => {
    const rows = okRowsByCode.get(stock.code) || [];
    const textFiles = collectTextFiles(stock, rows);
    const articles = textFiles.map((filePath) => readArticle(stock, filePath)).filter(Boolean);
    return {
      code: stock.code,
      name: stock.name,
      url: stock.url,
      articleCount: articles.length,
      articles
    };
  });

  const articleDates = items.flatMap((item) => item.articles.map((article) => article.date).filter(Boolean)).sort();
  return {
    generatedAt: new Date().toISOString(),
    reportDate: formatLocalDate(new Date()),
    source: {
      watchlistCsv: csvPath,
      runLog: runLogPath,
      latestNewsOutputDir: outputRoot
    },
    window: {
      from: articleDates[0] || "",
      to: articleDates.at(-1) || ""
    },
    stats: {
      watchlistCount: items.length,
      stocksWithArticles: items.filter((item) => item.articles.length).length,
      articleCount: items.reduce((sum, item) => sum + item.articles.length, 0)
    },
    watchlist: items
  };
}

function groupOkRowsByCode(rows) {
  const result = new Map();
  for (const row of rows) {
    if (String(row.status || "").trim() !== "ok") continue;
    const code = String(row.code || "").trim();
    if (!code) continue;
    if (!result.has(code)) result.set(code, []);
    result.get(code).push(row);
  }
  return result;
}

function collectTextFiles(stock, rows) {
  const files = new Set();
  for (const row of rows) {
    const filePath = normalizeLoggedPath(row.file);
    if (filePath && fs.existsSync(filePath) && filePath.toLowerCase().endsWith(".txt")) {
      files.add(filePath);
    }
  }

  if (files.size) return [...files].sort();

  const stockDir = findStockDir(stock.code);
  if (!stockDir) return [];
  return fs.readdirSync(stockDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".txt"))
    .map((entry) => path.join(stockDir, entry.name))
    .sort();
}

function findStockDir(code) {
  if (!fs.existsSync(outputRoot)) return "";
  const prefix = `${code}_`;
  const candidates = fs.readdirSync(outputRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(outputRoot, entry.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] || "";
}

function readArticle(stock, filePath) {
  const text = fs.readFileSync(filePath, "utf8").trim();
  const jsonPath = filePath.replace(/\.txt$/i, ".json");
  const meta = fs.existsSync(jsonPath) ? safeReadJson(jsonPath) : {};
  const title = meta.title || meta.latest?.title || titleFromFile(filePath, stock);
  const date = normalizeArticleDate(meta.date || meta.latest?.date || dateFromFile(filePath));
  const source = meta.source || meta.latest?.source || "";
  return {
    code: stock.code,
    name: stock.name,
    date,
    title,
    source,
    detailUrl: meta.detailUrl || meta.pageUrl || "",
    textFile: filePath,
    jsonFile: fs.existsSync(jsonPath) ? jsonPath : "",
    text: truncateText(text, maxArticleChars)
  };
}

function buildPromptBundle(data) {
  return [
    "# Watchlist Report Prompt",
    "",
    "Use the following system instruction and user input to generate the report.",
    "",
    "## System",
    "",
    finalReportSystemPrompt(),
    "",
    "## User",
    "",
    finalReportUserPrompt(data, data.watchlist.map((stock) => ({
      code: stock.code,
      name: stock.name,
      hasNewInfo: Boolean(stock.articles.length),
      articleCount: stock.articles.length,
      articles: stock.articles
    })))
  ].join("\n");
}

function stockSummarySystemPrompt() {
  return [
    "你是一名买方股票研究助理。",
    "只基于用户提供的单只 watchlist 股票资讯做分析，不要补充外部事实、价格、新闻或市场数据。",
    "如果资讯是宏观或行业内容，只在它明确影响这只股票时写入。",
    "输出必须是合法 JSON，不要写 Markdown，不要加解释。"
  ].join("\n");
}

function stockSummaryUserPrompt(stock) {
  return [
    "请把下面这只股票的隔夜资讯整理成结构化 JSON。",
    "",
    "JSON schema:",
    JSON.stringify({
      code: stock.code,
      name: stock.name,
      hasNewInfo: true,
      articleCount: stock.articles.length,
      direction: "利好/利空/中性/分歧/无新增",
      overnightStatus: "一句话概括隔夜变化",
      keyChanges: [
        {
          point: "核心变化",
          whyItMatters: "为什么重要",
          evidenceTitle: "对应文章标题"
        }
      ],
      detailedAnalysis: ["较详细的分析要点"],
      todayFocus: ["今日需要关注的事项"],
      sourceNotes: ["使用了哪些文章或来源"]
    }, null, 2),
    "",
    "Input:",
    JSON.stringify(stock, null, 2)
  ].join("\n");
}

function finalReportSystemPrompt() {
  return [
    "你是一名买方股票研究助理，要写一份 watchlist 股票隔夜变化报告。",
    "只覆盖输入里的 watchlist 股票，不写非 watchlist 股票。",
    "只使用输入材料和逐股票总结，不要补充外部事实、价格、新闻或市场数据。",
    "报告当前只需要关注 watchlist 股票本身，暂时不要写大盘总览、宏观总览或泛行业评论。",
    "有新增资讯的股票要写得比较详细：新增资讯、核心变化、对公司的影响、情绪判断、今日关注。",
    "没有新增资讯的股票只简短说明“本窗口未抓到新增资讯”，不要强行分析。",
    "输出 Markdown。"
  ].join("\n");
}

function finalReportUserPrompt(data, stockSummaries) {
  return [
    "请根据下面的数据生成报告。",
    "",
    "报告结构要求：",
    "1. 标题：Watchlist 隔夜变化报告",
    "2. 基本信息：报告日期、资讯窗口、watchlist 股票数、有新增资讯股票数、文章数。",
    "3. 总览表：股票、是否有新资讯、资讯数量、方向、今日关注。",
    "4. 逐股票详细分析：按 watchlist 顺序逐个写。",
    "5. 对有新增资讯的股票，写“隔夜新增资讯 / 核心变化 / 情绪判断 / 今日关注”。",
    "6. 对无新增资讯的股票，只写一句本窗口未抓到新增资讯。",
    "",
    "Report data:",
    JSON.stringify({
      reportDate: data.reportDate,
      window: data.window,
      stats: data.stats,
      watchlistOrder: data.watchlist.map((stock) => ({
        code: stock.code,
        name: stock.name,
        articleCount: stock.articleCount,
        articleTitles: stock.articles.map((article) => ({
          date: article.date,
          title: article.title,
          source: article.source
        }))
      })),
      stockSummaries
    }, null, 2)
  ].join("\n");
}

async function callOpenAi({ model, system, user }) {
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.2,
      max_output_tokens: 6000
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`OpenAI API failed (${response.status}): ${JSON.stringify(data)}`);
  }

  return data.output_text || extractOutputText(data);
}

function extractOutputText(data) {
  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
      if (content.type === "text" && content.text) parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function parseJsonFromModel(text, stock) {
  const cleaned = text.trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return {
      code: stock.code,
      name: stock.name,
      hasNewInfo: true,
      articleCount: stock.articles.length,
      direction: "待人工确认",
      overnightStatus: "AI 返回内容不是合法 JSON，已保留原文。",
      keyChanges: [],
      detailedAnalysis: [text.trim()],
      todayFocus: [],
      sourceNotes: stock.articles.map((article) => article.title)
    };
  }
}

function normalizeLoggedPath(value) {
  const text = String(value || "").trim().replace(/^"|"$/g, "");
  if (!text) return "";
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(rootDir, text);
}

function truncateText(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[TRUNCATED: original article has ${text.length} chars]`;
}

function titleFromFile(filePath, stock) {
  const name = path.basename(filePath, path.extname(filePath));
  return name
    .replace(/^\d{4}-\d{2}-\d{2}_/, "")
    .replace(`${stock.code}_`, "")
    .replace(`${stock.name}_`, "")
    .replace(/_/g, " ")
    .trim();
}

function dateFromFile(filePath) {
  return path.basename(filePath).match(/\d{4}-\d{2}-\d{2}/)?.[0] || "";
}

function normalizeArticleDate(value) {
  const text = String(value || "").trim();
  const fullDate = text.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (fullDate) return fullDate;
  const monthDay = text.match(/\b\d{2}-\d{2}\b/)?.[0];
  if (monthDay) return `${new Date().getFullYear()}-${monthDay}`;
  return text;
}

function formatLocalDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function resolveProjectPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);
}

function parsePositiveInt(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Invalid ${label} value: ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const result = {};
  const keyMap = new Map([
    ["--input", "input"],
    ["--stocks", "stocks"],
    ["--run-log", "runLog"],
    ["--output", "output"],
    ["--data-output", "dataOutput"],
    ["--summaries-output", "summariesOutput"],
    ["--prompt-output", "promptOutput"],
    ["--model", "model"],
    ["--max-article-chars", "maxArticleChars"]
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--no-ai" || arg === "--dry-run") {
      result.noAi = true;
      result.dryRun = true;
      continue;
    }

    const equalsIndex = arg.indexOf("=");
    if (equalsIndex > 2) {
      const key = arg.slice(0, equalsIndex);
      const mapped = keyMap.get(key);
      if (!mapped) throw new Error(`Unknown option: ${key}`);
      result[mapped] = arg.slice(equalsIndex + 1);
      continue;
    }

    const mapped = keyMap.get(arg);
    if (!mapped) throw new Error(`Unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    result[mapped] = value;
    index += 1;
  }

  return result;
}

function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = splitCsvLine(lines.shift() || "");
  return lines.map((line) => {
    const cells = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function safeReadJson(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return {};
  }
}
