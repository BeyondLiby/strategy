import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_NOTIFY_URL = "https://api.day.app/wF6yZEVtrVLqL7h2cnekwA/";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const options = parseArgs(process.argv.slice(2));
let attempt = 0;

while (true) {
  attempt += 1;

  if (attempt === 1 && options.loginFirst) {
    await notify("fof99 login", "loginFirst=true, starting manual login before extract");
    const loginCode = await runNodeScript("src/fof99/manual-login.js", []);
    if (loginCode !== 0) {
      await notify("fof99 login failed", `manual login exited with code ${loginCode}`);
    }
  }

  await notify("fof99 extract started", `attempt=${attempt}`);
  const extractCode = await runNodeScript("src/fof99/extract-net-values.js", options.extractArgs, {
    FOF99_NOTIFY_URL: options.notifyUrl,
    FOF99_NOTIFY_TITLE: options.notifyTitle
  });

  if (extractCode === 0) {
    await notify("fof99 extract finished", `attempt=${attempt} completed successfully`);
    if (!options.forever) break;
    await sleep(options.successDelaySeconds * 1000);
    continue;
  }

  await notify(
    "fof99 extract stopped",
    `attempt=${attempt} exited with code ${extractCode}. Starting fof99:login before retry.`
  );

  const loginCode = await runNodeScript("src/fof99/manual-login.js", []);
  if (loginCode !== 0) {
    await notify("fof99 login failed", `manual login exited with code ${loginCode}; retrying after delay`);
  } else {
    await notify("fof99 login finished", "manual login completed; retrying extract after delay");
  }

  if (options.maxAttempts > 0 && attempt >= options.maxAttempts) {
    await notify("fof99 loop stopped", `maxAttempts=${options.maxAttempts} reached`);
    process.exit(extractCode || 1);
  }

  await sleep(options.retryDelaySeconds * 1000);
}

function runNodeScript(scriptPath, scriptArgs, extraEnv = {}) {
  const args = [scriptPath, ...scriptArgs];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: rootDir,
      env: { ...process.env, ...extraEnv },
      stdio: "inherit",
      shell: false
    });

    child.on("error", (error) => {
      console.error(`[loop] failed to start ${scriptPath}: ${error.message}`);
      resolve(1);
    });
    child.on("close", (code, signal) => {
      if (signal) {
        console.error(`[loop] ${scriptPath} stopped by signal ${signal}`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function notify(title, body) {
  if (!options.notifyUrl) return;

  try {
    const cleanBase = options.notifyUrl.replace(/\/+$/, "");
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
  } catch (error) {
    console.error(`[notify] failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseArgs(argv) {
  const splitIndex = argv.indexOf("--");
  const hasSeparator = splitIndex >= 0;
  const loopArgs = splitIndex >= 0 ? argv.slice(0, splitIndex) : argv;
  const extractArgs = splitIndex >= 0 ? argv.slice(splitIndex + 1) : [];
  const result = {
    extractArgs,
    forever: false,
    loginFirst: false,
    maxAttempts: 0,
    notifyTitle: "fof99 extract progress",
    notifyUrl: process.env.FOF99_NOTIFY_URL || DEFAULT_NOTIFY_URL,
    retryDelaySeconds: 60,
    successDelaySeconds: 300
  };

  for (let index = 0; index < loopArgs.length; index += 1) {
    const arg = loopArgs[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = loopArgs[index + 1];
    const value = next && !next.startsWith("--") ? next : "true";
    if (value !== "true") index += 1;

    if (key === "forever") result.forever = value !== "false";
    else if (key === "loginFirst") result.loginFirst = value !== "false";
    else if (key === "maxAttempts") result.maxAttempts = Math.max(0, Number(value || 0));
    else if (key === "notifyTitle") result.notifyTitle = value;
    else if (key === "notifyUrl") result.notifyUrl = value;
    else if (key === "noNotify") result.notifyUrl = "";
    else if (key === "retryDelaySeconds") result.retryDelaySeconds = Math.max(0, Number(value || 0));
    else if (key === "successDelaySeconds") result.successDelaySeconds = Math.max(0, Number(value || 0));
    else {
      if (hasSeparator) {
        throw new Error(`Unknown loop option: --${key}. Put fof99:extract options after --`);
      }
      result.extractArgs.push(arg);
      if (value !== "true") result.extractArgs.push(value);
    }
  }

  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
