#!/usr/bin/env node
/**
 * e2e-run.js — Installs Playwright if needed, runs the generated test suite,
 * captures screenshots, and writes wiki/e2e-report.yaml.
 *
 * Usage:
 *   node e2e-run.js \
 *     --output-dir <dir> \
 *     --app-url <url>           # used for baseline health check before running
 *     [--env-file <path>]       # .env.test from emulator-start.js
 *     [--timeout <seconds>]     # per-test timeout override (default: 30)
 *     [--retries <n>]           # playwright retries (default: 1)
 *
 * Returns "ok:passed=<N>,failed=<F>,skipped=<S>" or "err:[description]"
 */

const fs   = require("fs");
const path = require("path");
const http = require("http");
const { execSync, spawnSync } = require("child_process");

// ── CLI args ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { timeout: 30, retries: 1 };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--output-dir":  parsed.outputDir = args[++i]; break;
      case "--app-url":     parsed.appUrl    = args[++i]; break;
      case "--env-file":    parsed.envFile   = args[++i]; break;
      case "--timeout":     parsed.timeout   = parseInt(args[++i], 10); break;
      case "--retries":     parsed.retries   = parseInt(args[++i], 10); break;
    }
  }
  return parsed;
}

// ── Env loader ────────────────────────────────────────────────────────────

function loadEnvFile(envFilePath) {
  const env = {};
  if (!envFilePath || !fs.existsSync(envFilePath)) return env;
  for (const line of fs.readFileSync(envFilePath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    env[t.slice(0, i)] = t.slice(i + 1);
  }
  return env;
}

// ── Playwright installer ──────────────────────────────────────────────────

function ensurePlaywright(e2eDir) {
  const pkgJson = path.join(e2eDir, "package.json");

  // Write a minimal package.json for the e2e directory if absent
  if (!fs.existsSync(pkgJson)) {
    fs.writeFileSync(pkgJson, JSON.stringify({
      name: "hpc-e2e",
      private: true,
      dependencies: { "@playwright/test": "^1.44.0" },
    }, null, 2));
  }

  // Install if node_modules absent
  if (!fs.existsSync(path.join(e2eDir, "node_modules"))) {
    execSync("npm install --prefer-offline", { cwd: e2eDir, stdio: "ignore", timeout: 120000 });
  }

  // Install browsers if missing (Chromium only for speed)
  try {
    execSync("npx playwright install chromium --with-deps", {
      cwd: e2eDir, stdio: "ignore", timeout: 180000,
    });
  } catch {
    // May fail on restricted network — continue anyway; test runner will report if browsers missing
  }
}

// ── App health check ──────────────────────────────────────────────────────

function checkAppReachable(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      resolve(res.statusCode < 500);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// ── JSON results parser ───────────────────────────────────────────────────

/**
 * Parse Playwright's JSON reporter output.
 */
function parsePlaywrightJson(jsonPath) {
  if (!fs.existsSync(jsonPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    let passed = 0, failed = 0, skipped = 0, flaky = 0;
    const failures = [];

    // Playwright's JSON reporter nests describe blocks as suite.suites and
    // reports per-test status as expected/unexpected/flaky/skipped.
    function walkSuite(suite) {
      for (const spec of (suite.specs || [])) {
        for (const test of (spec.tests || [])) {
          switch (test.status) {
            case "expected":
            case "passed":  passed++;  break;
            case "unexpected":
            case "failed":  failed++;
              failures.push({
                title: spec.title,
                file:  spec.file,
                error: (test.results?.[0]?.error?.message || "").slice(0, 300),
              });
              break;
            case "skipped": skipped++; break;
            case "flaky":   flaky++; passed++; break;
          }
        }
      }
      for (const child of (suite.suites || [])) walkSuite(child);
    }
    for (const suite of (data.suites || [])) walkSuite(suite);

    return { passed, failed, skipped, flaky, failures, raw: data };
  } catch {
    return null;
  }
}

// ── Screenshot inventory ──────────────────────────────────────────────────

function collectScreenshots(screenshotsDir) {
  if (!fs.existsSync(screenshotsDir)) return [];
  return fs.readdirSync(screenshotsDir)
    .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .map(f => path.join(screenshotsDir, f));
}

// ── YAML report builder ───────────────────────────────────────────────────

function buildYamlReport({ results, screenshots, appUrl, durationMs }) {
  const lines = [
    "# Auto-generated by e2e-run.js — do not edit manually",
    "",
    `app_url: "${appUrl}"`,
    `duration_ms: ${durationMs}`,
    `passed: ${results.passed}`,
    `failed: ${results.failed}`,
    `skipped: ${results.skipped}`,
    `flaky: ${results.flaky}`,
    `all_green: ${results.failed === 0}`,
    "",
  ];

  if (results.failures.length > 0) {
    lines.push("failures:");
    for (const f of results.failures) {
      lines.push(`  - title: "${f.title.replace(/"/g, '\\"')}"`);
      lines.push(`    file: "${f.file}"`);
      lines.push(`    error: "${f.error.replace(/"/g, '\\"').replace(/\n/g, " ")}"`);
    }
    lines.push("");
  }

  if (screenshots.length > 0) {
    lines.push("screenshots:");
    for (const s of screenshots) {
      lines.push(`  - ${path.basename(s)}`);
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  if (!args.outputDir || !args.appUrl) {
    console.log("err:usage: node e2e-run.js --output-dir <dir> --app-url <url>");
    process.exit(0);
  }

  const e2eDir         = path.join(args.outputDir, "e2e");
  const screenshotsDir = path.join(args.outputDir, "screenshots");
  const wikiDir        = path.join(args.outputDir, "wiki");

  if (!fs.existsSync(e2eDir)) {
    console.log(`err:e2e_dir_not_found: ${e2eDir} — run e2e-generate.js first`);
    process.exit(0);
  }

  const specFile = path.join(e2eDir, "tests.spec.ts");
  if (!fs.existsSync(specFile)) {
    console.log(`err:spec_not_found: ${specFile} — run e2e-generate.js first`);
    process.exit(0);
  }

  // Pre-flight: check app is reachable
  const appReachable = await checkAppReachable(args.appUrl);
  if (!appReachable) {
    console.log(`err:app_unreachable: ${args.appUrl} is not responding — start the app first`);
    process.exit(0);
  }

  // Install Playwright
  ensurePlaywright(e2eDir);

  // Load env vars
  const envFile = args.envFile || path.join(args.outputDir, "emulator", ".env.test");
  const extraEnv = loadEnvFile(envFile);

  // Ensure screenshots dir exists
  fs.mkdirSync(screenshotsDir, { recursive: true });

  // Build playwright test command
  const resultsJsonPath = path.resolve(e2eDir, "e2e-results.json");
  const configPath      = path.join(e2eDir, "playwright.config.ts");

  // Override screenshot dir via env so tests write to the right place
  const screenshotEnv = `SCREENSHOTS_DIR=${screenshotsDir}`;

  const playwrightCmd = [
    "npx", "playwright", "test",
    "--config", configPath,
    "--reporter=json",
    `--timeout=${args.timeout * 1000}`,
    `--retries=${args.retries}`,
  ].join(" ");

  const logPath = path.join(e2eDir, "e2e-run.log");
  const logFd   = fs.openSync(logPath, "w");

  const t0 = Date.now();
  const result = spawnSync("npx", [
    "playwright", "test",
    "--config", configPath,
    `--timeout=${args.timeout * 1000}`,
    `--retries=${args.retries}`,
    "--reporter=json",
  ], {
    cwd: e2eDir,
    env: {
      ...process.env,
      ...extraEnv,
      SCREENSHOTS_DIR: screenshotsDir,
      BASE_URL: args.appUrl,
      PLAYWRIGHT_JSON_OUTPUT_NAME: resultsJsonPath,
    },
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const durationMs = Date.now() - t0;

  // Log output for debugging
  fs.writeFileSync(logPath, (result.stdout || "") + "\n" + (result.stderr || ""));

  // Parse JSON results — Playwright writes to the path in playwright.config.ts
  const results = parsePlaywrightJson(resultsJsonPath);

  if (!results) {
    // No JSON output — infer from exit code
    const exitCode = result.status;
    if (exitCode === 0) {
      // Playwright exited green but never wrote results JSON — the reporter
      // wiring is broken; refuse to report success without evidence.
      console.log("err:results_missing");
      process.exit(1);
    } else {
      // Try to surface something from stdout
      const summary = (result.stdout || "").split("\n").slice(-5).join(" ").trim().slice(0, 200);
      console.log(`err:playwright_failed:${summary || "check " + logPath}`);
    }
    process.exit(0);
  }

  // Collect screenshots that were written
  const screenshots = collectScreenshots(screenshotsDir);

  // Write wiki/e2e-report.yaml
  fs.mkdirSync(wikiDir, { recursive: true });
  const reportYaml = buildYamlReport({
    results,
    screenshots,
    appUrl: args.appUrl,
    durationMs,
  });
  fs.writeFileSync(path.join(wikiDir, "e2e-report.yaml"), reportYaml);

  if (results.failed > 0) {
    console.log(`err:failed=${results.failed},passed=${results.passed},skipped=${results.skipped}`);
    process.exit(1);
  }
  console.log(`ok:passed=${results.passed},failed=0,skipped=${results.skipped}`);
}

main().catch(err => {
  console.log(`err:unexpected:${err.message}`);
  process.exit(0);
});
