#!/usr/bin/env node
/**
 * app-serve.js — Starts the built application in dev/preview mode, waits for
 * it to be ready, and writes the bound URL to emulator/app-url.txt.
 *
 * Usage:
 *   node app-serve.js \
 *     --manifest-dir <dir> \
 *     --output-dir <dir> \
 *     --app-dir <dir>          # root of the assembled application
 *     [--port <n>]             # override detected default port (default: 3000)
 *     [--env-file <path>]      # .env.test file from emulator-start.js
 *     [--timeout <seconds>]    # readiness timeout (default: 90)
 *     [--shutdown]             # kill the previously started app process
 *
 * Returns "ok:url=http://localhost:<port>" or "err:[description]"
 */

const fs    = require("fs");
const path  = require("path");
const http  = require("http");
const https = require("https");
const { execSync, spawn } = require("child_process");

// ── CLI args ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { port: null, timeout: 90 };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--manifest-dir": parsed.manifestDir = args[++i]; break;
      case "--output-dir":   parsed.outputDir   = args[++i]; break;
      case "--app-dir":      parsed.appDir       = args[++i]; break;
      case "--port":         parsed.port         = parseInt(args[++i], 10); break;
      case "--env-file":     parsed.envFile      = args[++i]; break;
      case "--timeout":      parsed.timeout      = parseInt(args[++i], 10); break;
      case "--shutdown":     parsed.shutdown     = true; break;
    }
  }
  return parsed;
}

// ── Simple YAML reader ────────────────────────────────────────────────────

function readInfraYaml(manifestDir) {
  const p = path.join(manifestDir, "infra-requirements.yaml");
  if (!fs.existsSync(p)) return null;
  const content = fs.readFileSync(p, "utf-8");
  const result = { framework: { type: "unknown", serve_command: null } };

  for (const line of content.split("\n")) {
    const m = line.match(/^\s{2}(type|serve_command):\s*(.+)$/);
    if (m && result._inFramework) {
      result.framework[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    if (/^framework:/.test(line)) result._inFramework = true;
    else if (/^\w/.test(line) && !/^framework:/.test(line)) result._inFramework = false;
  }
  return result;
}

// ── .env.test loader ──────────────────────────────────────────────────────

function loadEnvFile(envFilePath) {
  const env = {};
  if (!envFilePath || !fs.existsSync(envFilePath)) return env;
  for (const line of fs.readFileSync(envFilePath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
  return env;
}

// ── Framework detection ───────────────────────────────────────────────────

/**
 * Detect framework and default port from infra-requirements.yaml or
 * fall back to scanning package.json in appDir.
 */
function detectFramework(infra, appDir) {
  if (infra && infra.framework && infra.framework.type !== "unknown") {
    return {
      type: infra.framework.type,
      serveCmd: infra.framework.serve_command,
    };
  }

  // Fallback: read package.json
  const pkgPath = path.join(appDir, "package.json");
  if (!fs.existsSync(pkgPath)) return { type: "unknown", serveCmd: "npm start" };

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  if (deps["next"])      return { type: "nextjs",    serveCmd: "next dev" };
  if (deps["nuxt"])      return { type: "nuxt",      serveCmd: "nuxt dev" };
  if (deps["@sveltejs/kit"]) return { type: "sveltekit", serveCmd: "vite dev" };
  if (deps["vite"])      return { type: "vite",      serveCmd: "vite preview" };
  if (deps["remix"])     return { type: "remix",     serveCmd: "remix dev" };
  if (deps["express"])   return { type: "express",   serveCmd: "node src/index.js" };
  if (deps["fastify"])   return { type: "fastify",   serveCmd: "node src/index.js" };

  // Use npm start as universal fallback
  if (pkg.scripts && pkg.scripts.dev)   return { type: "npm", serveCmd: "npm run dev" };
  if (pkg.scripts && pkg.scripts.start) return { type: "npm", serveCmd: "npm start" };

  return { type: "unknown", serveCmd: "npm start" };
}

/**
 * Return the default port for a given framework.
 */
function defaultPortFor(frameworkType) {
  const MAP = {
    nextjs:    3000,
    nuxt:      3000,
    sveltekit: 5173,
    vite:      4173,
    remix:     3000,
    express:   3000,
    fastify:   3000,
    npm:       3000,
    unknown:   3000,
  };
  return MAP[frameworkType] || 3000;
}

// ── Readiness check ───────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function httpGet(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: 3000 }, (res) => {
      resolve({ ok: true, status: res.statusCode });
      res.resume();
    });
    req.on("error", () => resolve({ ok: false }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false }); });
  });
}

async function waitForApp(url, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const result = await httpGet(url);
    if (result.ok) return true;
    await sleep(2000);
  }
  return false;
}

// ── PID tracking ──────────────────────────────────────────────────────────

function pidFile(outputDir) {
  return path.join(outputDir, "emulator", "app-pid.txt");
}

function writePid(outputDir, pid) {
  fs.mkdirSync(path.join(outputDir, "emulator"), { recursive: true });
  fs.writeFileSync(pidFile(outputDir), String(pid));
}

function readPid(outputDir) {
  const p = pidFile(outputDir);
  if (!fs.existsSync(p)) return null;
  const v = parseInt(fs.readFileSync(p, "utf-8").trim(), 10);
  return isNaN(v) ? null : v;
}

function writeAppUrl(outputDir, url) {
  fs.mkdirSync(path.join(outputDir, "emulator"), { recursive: true });
  fs.writeFileSync(path.join(outputDir, "emulator", "app-url.txt"), url);
}

// ── Shutdown ──────────────────────────────────────────────────────────────

function shutdown(outputDir) {
  const pid = readPid(outputDir);
  if (pid) {
    try {
      // Kill the process group so child processes (like webpack) also die
      process.kill(-pid, "SIGTERM");
    } catch {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    try { fs.unlinkSync(pidFile(outputDir)); } catch {}
  }
  try { fs.unlinkSync(path.join(outputDir, "emulator", "app-url.txt")); } catch {}
  console.log("ok:shutdown_complete");
}

// ── npm install check ─────────────────────────────────────────────────────

function ensureDepsInstalled(appDir) {
  if (!fs.existsSync(path.join(appDir, "node_modules"))) {
    try {
      execSync("npm install --prefer-offline", { cwd: appDir, stdio: "ignore", timeout: 120000 });
    } catch {
      // Best-effort — if offline install fails, try online
      try { execSync("npm install", { cwd: appDir, stdio: "ignore", timeout: 180000 }); } catch {}
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  if (!args.outputDir) {
    console.log("err:usage: node app-serve.js --output-dir <dir> --app-dir <dir> --manifest-dir <dir>");
    process.exit(0);
  }

  if (args.shutdown) {
    shutdown(args.outputDir);
    return;
  }

  if (!args.appDir) {
    console.log("err:usage: --app-dir is required unless --shutdown");
    process.exit(0);
  }

  if (!fs.existsSync(args.appDir)) {
    console.log(`err:app_dir_not_found: ${args.appDir}`);
    process.exit(0);
  }

  // Read infra yaml for framework info
  const infra = args.manifestDir ? readInfraYaml(args.manifestDir) : null;
  const { type: frameworkType, serveCmd } = detectFramework(infra, args.appDir);

  const port = args.port || defaultPortFor(frameworkType);
  const appUrl = `http://localhost:${port}`;

  // Load env vars from .env.test
  const envFile = args.envFile || path.join(args.outputDir, "emulator", ".env.test");
  const emulatorEnv = loadEnvFile(envFile);

  // Ensure deps are installed
  ensureDepsInstalled(args.appDir);

  // Build the serve command
  const [cmd, ...cmdArgs] = serveCmd.split(/\s+/);

  const logPath = path.join(args.outputDir, "emulator", "app-serve.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, "a");

  const child = spawn(cmd, cmdArgs, {
    cwd: args.appDir,
    env: {
      ...process.env,
      ...emulatorEnv,
      PORT: String(port),
      NODE_ENV: "development",
    },
    stdio: ["ignore", logFd, logFd],
    detached: true,  // allows process group kill
  });

  child.on("error", (err) => {
    fs.appendFileSync(logPath, `\n[app-serve.js] spawn error: ${err.message}\n`);
  });

  writePid(args.outputDir, child.pid);

  // Detach fully so the open child handle/fd cannot keep this process alive
  child.unref();
  try { fs.closeSync(logFd); } catch {}

  // Wait for the app to accept connections
  const ready = await waitForApp(appUrl, args.timeout);

  if (!ready) {
    // Kill what we started
    try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill(); } catch {} }
    try { fs.unlinkSync(pidFile(args.outputDir)); } catch {}
    console.log(`err:app_not_ready: ${frameworkType} app did not respond at ${appUrl} within ${args.timeout}s — check ${logPath}`);
    process.exit(0);
  }

  writeAppUrl(args.outputDir, appUrl);
  console.log(`ok:url=${appUrl}`);
  process.exit(0);
}

main().catch(err => {
  console.log(`err:unexpected:${err.message}`);
  process.exit(0);
});
