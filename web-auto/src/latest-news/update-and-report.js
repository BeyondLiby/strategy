import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const args = parseArgs(process.argv.slice(2));

const extractScript = path.join(rootDir, "src/latest-news/extract.js");
const reportScript = path.join(rootDir, "src/latest-news/report.js");

const extractArgs = buildExtractArgs(args);
const reportArgs = buildReportArgs(args);

console.log("== AlphaPai update + watchlist report ==");
if (!args.skipExtract) {
  console.log(`\n[1/2] Updating latest news: node ${relative(extractScript)} ${extractArgs.join(" ")}`);
  await runNode(extractScript, extractArgs);
} else {
  console.log("\n[1/2] Skipping latest-news update.");
}

if (!args.skipReport) {
  console.log(`\n[2/2] Generating watchlist report: node ${relative(reportScript)} ${reportArgs.join(" ")}`);
  await runNode(reportScript, reportArgs);
} else {
  console.log("\n[2/2] Skipping report generation.");
}

console.log("\nDone.");

function buildExtractArgs(parsed) {
  const result = [];
  const hasDateWindow = parsed.extract.some((arg) => (
    arg === "--date" ||
    arg.startsWith("--date=") ||
    arg === "--from" ||
    arg.startsWith("--from=") ||
    arg === "--to" ||
    arg.startsWith("--to=") ||
    arg === "--day" ||
    arg.startsWith("--day=") ||
    arg === "--days" ||
    arg.startsWith("--days=")
  ));
  const hasConcurrency = parsed.extract.some((arg) => arg === "--concurrency" || arg.startsWith("--concurrency="));

  if (!hasDateWindow) result.push("--day", "2");
  if (!hasConcurrency) result.push("--concurrency", "2");
  result.push(...parsed.extract);
  return result;
}

function buildReportArgs(parsed) {
  return [...parsed.report];
}

function parseArgs(argv) {
  const extractOptions = new Set(["--code", "--name", "--url", "--date", "--from", "--to", "--days", "--day", "--concurrency"]);
  const reportOptions = new Set([
    "--input",
    "--stocks",
    "--run-log",
    "--output",
    "--data-output",
    "--summaries-output",
    "--prompt-output",
    "--model",
    "--max-article-chars"
  ]);
  const reportFlags = new Set(["--no-ai", "--dry-run"]);
  const workflowFlags = new Set(["--skip-extract", "--skip-report"]);

  const result = {
    extract: [],
    report: [],
    skipExtract: false,
    skipReport: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const key = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;

    if (workflowFlags.has(key)) {
      if (key === "--skip-extract") result.skipExtract = true;
      if (key === "--skip-report") result.skipReport = true;
      continue;
    }

    if (reportFlags.has(key)) {
      result.report.push(arg);
      continue;
    }

    if (extractOptions.has(key)) {
      pushOption(result.extract, argv, index);
      if (!arg.includes("=")) index += 1;
      continue;
    }

    if (reportOptions.has(key)) {
      pushOption(result.report, argv, index);
      if (!arg.includes("=")) index += 1;
      continue;
    }

    throw new Error(`Unknown option for update report workflow: ${arg}`);
  }

  return result;
}

function pushOption(target, argv, index) {
  const arg = argv[index];
  target.push(arg);
  if (arg.includes("=")) return;

  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${arg}`);
  }
  target.push(value);
}

function runNode(scriptPath, scriptArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...scriptArgs], {
      cwd: rootDir,
      stdio: "inherit",
      env: process.env
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${path.basename(scriptPath)} failed with ${signal || `exit code ${code}`}`));
      }
    });
  });
}

function relative(filePath) {
  return path.relative(rootDir, filePath).replaceAll("\\", "/");
}
