import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const args = parseArgs(process.argv.slice(2));
const outputPath = resolveProjectPath(args.output || "data/stocks.csv");
const inputPath = args.input ? resolveReadablePath(args.input) : "";

const urls = [
  ...expandPositionals(args.positionals),
  ...readInputUrls(inputPath)
].map((value) => value.trim()).filter(Boolean);

if (!urls.length) {
  throw new Error("No URLs provided. Pass URLs as arguments or use --input stock-urls.txt.");
}

const existingRows = fs.existsSync(outputPath) ? readCsv(outputPath) : [];
const rowsByCode = new Map();

for (const row of existingRows) {
  if (row.code) rowsByCode.set(row.code, row);
}

for (const rawUrl of urls) {
  const row = parseStockUrl(rawUrl);
  rowsByCode.set(row.code, {
    ...rowsByCode.get(row.code),
    ...row
  });
}

const rows = [...rowsByCode.values()].sort((a, b) => a.code.localeCompare(b.code));
writeCsv(outputPath, ["code", "name", "url"], rows);

console.log(`Wrote ${rows.length} rows to ${outputPath}`);
for (const row of rows) {
  console.log(`${row.code}\t${row.name}`);
}

function parseStockUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid stock URL: ${rawUrl}`);
  }

  const code = url.searchParams.get("id")?.trim();
  const name = url.searchParams.get("name")?.trim();

  if (!code || !name) {
    throw new Error(`URL missing id or name query param: ${rawUrl}`);
  }

  return {
    code,
    name,
    url: url.href
  };
}

function expandPositionals(values) {
  return values.flatMap((value) => {
    if (looksLikeUrl(value)) return [value];

    const filePath = resolveReadablePath(value, { mustExist: false });
    if (filePath && fs.existsSync(filePath)) return readInputUrls(filePath);

    if (looksLikePath(value)) {
      throw new Error(`Input file not found: ${filePath}`);
    }

    return [value];
  });
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function looksLikePath(value) {
  const text = String(value || "");
  return /[\\/]|\.[a-z0-9]+$/i.test(text);
}

function readInputUrls(filePath) {
  if (!filePath) return [];
  if (!fs.existsSync(filePath)) {
    throw new Error(`Input file not found: ${filePath}`);
  }

  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function resolveProjectPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);
}

function resolveReadablePath(filePath, options = { mustExist: true }) {
  if (!filePath) return "";
  if (path.isAbsolute(filePath)) return filePath;

  const candidates = [
    path.resolve(process.cwd(), filePath),
    path.resolve(rootDir, filePath),
    path.resolve(rootDir, "data", filePath)
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found || options.mustExist === false) return found || candidates[0];
  return candidates[0];
}

function parseArgs(argv) {
  const result = { positionals: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--input=")) {
      result.input = arg.slice("--input=".length);
    } else if (arg.startsWith("--output=")) {
      result.output = arg.slice("--output=".length);
    } else if (arg === "--input" || arg === "-i") {
      result.input = argv[++index];
    } else if (arg === "--output" || arg === "-o") {
      result.output = argv[++index];
    } else {
      result.positionals.push(arg);
    }
  }
  return result;
}

function readCsv(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];

  const headers = splitCsvLine(lines.shift());
  return lines.map((line) => {
    const cells = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
}

function writeCsv(filePath, headers, rows) {
  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
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

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}
