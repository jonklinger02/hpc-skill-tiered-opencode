#!/usr/bin/env node
/**
 * e2e-chase.js — Tiered E2E failure-chase loop for HPC Phase 4.
 *
 * Implements the escalation ladder:
 *   Rounds 0–1  → Tier 1: Sonnet single-agent  (cheap, fast)
 *   Round 2     → Tier 2: Opus single-agent    (deeper reasoning)
 *   Round 3     → Tier 3: Council              (senior-engineer + critic + synthesizer)
 *   Round 4     → Tier 4: dump failure report and stop
 *
 * Usage:
 *   node e2e-chase.js \
 *     --e2e-dir <dir>           (default: e2e/)
 *     --app-dir <dir>           (default: ./)
 *     --app-port <port>         (default: 3000)
 *     --pid-file <file>         (default: output/emulator/app-pid.txt — matches app-serve.js)
 *     --output-file <file>      (default: PHASE4-FAILURE-REPORT.md)
 *     --max-rounds <n>          (default: 5)
 *     --diag-dir <dir>          (default: <e2e-dir>/_diag/)
 *
 * Returns "ok:rounds=<N>,passed=<P>/<T>" or "err:<reason>"
 */

"use strict";

const fs    = require("fs");
const path  = require("path");
const http  = require("http");
const { spawnSync, execSync, spawn } = require("child_process");
const { resolveModel } = require("./lib/models.js");
const { callAgent } = require("./lib/opencode-client");

// ── CLI args ──────────────────────────────────────────────────────────────

// M5 §5.1 — on chase exhaustion, hand the failure to the autonomous recovery
// ladder (deliberate-fork drains pending forks at escalating tiers) instead of
// stopping for a human. Opt-in via --recover-on-exhaust (+ --manifest-dir --store).
// Returns true if recovery was triggered.
function maybeRecover(args) {
  if (!args.recoverOnExhaust || !args.manifestDir || !args.store) return false;
  const deliberate = path.join(__dirname, "deliberate-fork.js");
  console.log(`recover-on-exhaust: handing Phase-4 exhaustion to the recovery ladder`);
  const r = spawnSync("node", [deliberate, "--manifest-dir", args.manifestDir, "--store", args.store, "--all"],
    { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024, timeout: 1800000 });
  const out = ((r.stdout || "") + (r.stderr || "")).trim().split("\n").slice(-3).join(" | ");
  console.log(`recover-on-exhaust result: ${out.slice(0, 400)}`);
  return true;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    e2eDir:     "e2e/",
    appDir:     "./",
    appPort:    3000,
    pidFile:    "output/emulator/app-pid.txt",
    outputFile: "PHASE4-FAILURE-REPORT.md",
    maxRounds:  5,
    diagDir:    null,   // resolved after e2eDir is set
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--e2e-dir":     parsed.e2eDir     = args[++i]; break;
      case "--app-dir":     parsed.appDir     = args[++i]; break;
      case "--app-port":    parsed.appPort    = parseInt(args[++i], 10); break;
      case "--pid-file":    parsed.pidFile    = args[++i]; break;
      case "--output-file": parsed.outputFile = args[++i]; break;
      case "--max-rounds":  parsed.maxRounds  = parseInt(args[++i], 10); break;
      case "--diag-dir":    parsed.diagDir    = args[++i]; break;
      // M5 §5.1 — on Tier-4 chase exhaustion, hand off to the autonomous
      // recovery ladder instead of stopping for a human (opt-in).
      case "--recover-on-exhaust": parsed.recoverOnExhaust = true; break;
      case "--manifest-dir": parsed.manifestDir = args[++i]; break;
      case "--store":        parsed.store       = args[++i]; break;
    }
  }
  if (!parsed.diagDir) {
    parsed.diagDir = path.join(parsed.e2eDir, "_diag");
  }
  return parsed;
}

// ── Utility helpers ───────────────────────────────────────────────────────

function safeRead(p) {
  if (!p || !fs.existsSync(p)) return null;
  try { return fs.readFileSync(p, "utf-8"); } catch { return null; }
}

function safeWrite(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** Return mtime in ms for a file, or 0 if it does not exist. */
function mtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

// ── Playwright runner ─────────────────────────────────────────────────────

/**
 * Run the Playwright suite and return { exitCode, stdout, stderr, passed, failed, total }.
 * We use --reporter=list (human-readable) for the diag capture and attempt to
 * extract pass/fail counts from the summary line.
 */
function runPlaywright(e2eDir, appPort) {
  const configPath = path.join(e2eDir, "playwright.config.ts");
  const env = {
    ...process.env,
    BASE_URL: `http://localhost:${appPort}`,
    CI: "1",           // Playwright respects CI=1 to disable interactive mode
  };

  const result = spawnSync("npx", [
    "playwright", "test",
    "--config", configPath,
    "--reporter=list",
  ], {
    cwd: e2eDir,
    env,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 300000,   // 5 minutes per run
  });

  const combined = (result.stdout || "") + "\n" + (result.stderr || "");

  // Parse summary line: "N passed (Xs)" / "N failed" / "N passed, N failed"
  let passed = 0, failed = 0, total = 0;
  const passMatch = combined.match(/(\d+)\s+passed/);
  const failMatch = combined.match(/(\d+)\s+failed/);
  if (passMatch) passed = parseInt(passMatch[1], 10);
  if (failMatch) failed = parseInt(failMatch[1], 10);
  total = passed + failed;

  return {
    exitCode: result.status ?? 1,
    stdout:   result.stdout || "",
    stderr:   result.stderr || "",
    output:   combined,
    passed,
    failed,
    total,
  };
}

// ── Context capture (per-round, no LLM) ──────────────────────────────────

/**
 * Capture the failure context for this round and write to diagDir/round-N.txt.
 * Always writes and returns the path. Idempotent: if file already exists, skip
 * re-capture and return the existing path.
 */
function captureContext(round, diagDir, e2eDir, appPort, appDir, runResult) {
  const diagFile = path.join(diagDir, `round-${round}.txt`);
  if (fs.existsSync(diagFile)) return diagFile;   // idempotent re-run

  const appUrl = `http://localhost:${appPort}`;
  const parts  = [];

  parts.push(`=== Round ${round} Failure Context ===`);
  parts.push(`Timestamp: ${new Date().toISOString()}`);
  parts.push("");

  // 1. Playwright output (already in memory from the run that preceded capture)
  parts.push("--- Playwright Output ---");
  parts.push(runResult.output.slice(0, 8000));
  parts.push("");

  // 2. HTTP sanity check
  parts.push("--- HTTP Health Check ---");
  try {
    const curl = spawnSync("curl", ["-si", "--max-time", "5", appUrl], {
      encoding: "utf-8", timeout: 8000,
    });
    parts.push((curl.stdout || "").slice(0, 2000));
  } catch (e) {
    parts.push(`curl error: ${e.message}`);
  }
  parts.push("");

  // 3. Page HTML excerpt
  parts.push("--- Page HTML Excerpt (first 200 lines) ---");
  try {
    const curl = spawnSync("curl", ["-s", "--max-time", "5", appUrl], {
      encoding: "utf-8", timeout: 8000,
    });
    const lines = (curl.stdout || "").split("\n").slice(0, 200).join("\n");
    parts.push(lines.slice(0, 6000));
  } catch (e) {
    parts.push(`curl error: ${e.message}`);
  }
  parts.push("");

  // 4. Server log tail
  const logCandidates = [
    path.join("output", "emulator", "app-serve.log"),
    path.join("emulator", "app-serve.log"),
  ];
  parts.push("--- Server Log Tail (last 200 lines) ---");
  let logFound = false;
  for (const lp of logCandidates) {
    if (fs.existsSync(lp)) {
      try {
        const tail = spawnSync("tail", ["-200", lp], { encoding: "utf-8", timeout: 5000 });
        parts.push((tail.stdout || "").slice(0, 4000));
        logFound = true;
      } catch {}
      break;
    }
  }
  if (!logFound) parts.push("(server log not found)");
  parts.push("");

  // 5. Playwright screenshots from this run
  parts.push("--- Playwright Screenshots ---");
  const screenshotDirs = [
    path.join(e2eDir, "test-results"),
    path.join(e2eDir, "..", "screenshots"),
  ];
  for (const sd of screenshotDirs) {
    if (fs.existsSync(sd)) {
      const shots = fs.readdirSync(sd).filter(f => /\.(png|jpg)$/i.test(f));
      if (shots.length > 0) {
        parts.push(`Screenshots in ${sd}:`);
        shots.slice(0, 10).forEach(s => parts.push(`  ${path.join(sd, s)}`));
      }
    }
  }
  parts.push("");

  // 6. Mtime sweep for key source files
  parts.push("--- Modified Files (mtime sweep) ---");
  const watchPaths = [
    path.join(appDir, "app", "page.tsx"),
    path.join(appDir, "app", "admin", "login", "page.tsx"),
    path.join(appDir, "src", "app", "page.tsx"),
  ];
  for (const wp of watchPaths) {
    if (fs.existsSync(wp)) {
      const st = fs.statSync(wp);
      parts.push(`  ${wp}: mtime=${new Date(st.mtimeMs).toISOString()}, size=${st.size}B`);
    }
  }
  // git diff if available
  try {
    const diff = spawnSync("git", ["diff", "--stat", "HEAD"], {
      encoding: "utf-8", timeout: 10000,
    });
    if (diff.stdout && diff.stdout.trim()) {
      parts.push("");
      parts.push("git diff --stat HEAD:");
      parts.push(diff.stdout.slice(0, 3000));
    }
  } catch {}
  parts.push("");

  const content = parts.join("\n");
  safeWrite(diagFile, content);
  return diagFile;
}

// ── File snapshot helpers (for regression revert) ─────────────────────────

/**
 * Snapshot the content of files likely to be modified during a repair pass.
 * Returns a map of { absolutePath -> content|null }.
 */
function snapshotFiles(appDir) {
  const candidates = [];

  // Walk the app directory for .ts/.tsx/.js/.jsx/.css source files
  function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // Skip dependency and build dirs
        if ([".next", "node_modules", ".git", "dist", "out", "build"].includes(e.name)) continue;
        walk(full, depth + 1);
      } else if (/\.(ts|tsx|js|jsx|css|scss|json)$/.test(e.name)) {
        candidates.push(full);
      }
    }
  }

  walk(appDir, 0);

  const snap = {};
  for (const p of candidates) {
    snap[p] = safeRead(p);
  }
  return snap;
}

/**
 * Restore files from a snapshot. Only restores files that exist in the snapshot
 * and whose current content differs (avoids unnecessary writes).
 */
function restoreSnapshot(snap) {
  for (const [p, content] of Object.entries(snap)) {
    if (content === null) continue;
    const current = safeRead(p);
    if (current !== content) {
      try { fs.writeFileSync(p, content); } catch {}
    }
  }
}

// ── RESTART_DEV sentinel ──────────────────────────────────────────────────

/**
 * If the repair agent left a RESTART_DEV sentinel, kill the current app
 * process (identified by pidFile) and start `next dev` again. Waits for
 * the app to become responsive before returning.
 */
async function maybeRestartDev(diagDir, pidFile, appDir, appPort) {
  const sentinelPath = path.join(diagDir, "RESTART_DEV");
  if (!fs.existsSync(sentinelPath)) return;

  // Remove sentinel so next round doesn't trigger again
  try { fs.unlinkSync(sentinelPath); } catch {}

  // Kill the old process
  if (fs.existsSync(pidFile)) {
    const pidStr = safeRead(pidFile);
    if (pidStr) {
      const pid = parseInt(pidStr.trim(), 10);
      if (!isNaN(pid)) {
        try { process.kill(-pid, "SIGTERM"); } catch {}
        try { process.kill(pid, "SIGTERM"); } catch {}
      }
    }
    try { fs.unlinkSync(pidFile); } catch {}
  }

  // Short grace period for port to free up
  await sleep(2000);

  // Detect serve command from package.json
  const pkgPath = path.join(appDir, "package.json");
  let serveCmd = "next dev";
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (!deps["next"]) {
        serveCmd = pkg.scripts?.dev ? "npm run dev" : "npm start";
      }
    } catch {}
  }

  const logPath = path.join(path.dirname(pidFile), "app-serve.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, "a");

  const [cmd, ...cmdArgs] = serveCmd.split(/\s+/);
  const child = spawn(cmd, cmdArgs, {
    cwd: appDir,
    env: { ...process.env, PORT: String(appPort), NODE_ENV: "development" },
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });

  // Detach fully so the open child handle/fd cannot keep this process alive
  child.unref();
  try { fs.closeSync(logFd); } catch {}

  // Write new PID
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(child.pid));

  // Wait for app to respond (up to 60s)
  const deadline = Date.now() + 60000;
  const appUrl = `http://localhost:${appPort}`;
  while (Date.now() < deadline) {
    await sleep(2000);
    try {
      const ok = await httpPing(appUrl);
      if (ok) return;
    } catch {}
  }
  // Non-fatal: log and continue; Playwright will surface the problem
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function httpPing(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      resolve(res.statusCode < 500);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// ── Repair-agent dispatch ─────────────────────────────────────────────────

/**
 * Tier 1 & 2: single-agent call via the OpenCode serve API.
 * Returns { ok: true, text } or { ok: false, error }.
 */
async function dispatchSingleAgent(model, systemPrompt, userMessage, timeoutMs = 900000) {
  const result = await callAgent({
    role: "e2e_chase_tier1",
    model: resolveModel(model),
    systemPrompt,
    userMessage,
    timeoutMs,
    tools: { read: true, edit: true, bash: true, glob: true, grep: true, list: true },
    effort: null,
  });
  if (result.error) {
    return { ok: false, error: result.error };
  }
  return { ok: true, text: result.text };
}

/**
 * Tier 3: Council deliberation — three personas in sequence:
 *   1. senior-engineer → produces proposed patch
 *   2. critic          → tears apart the proposal
 *   3. synthesizer     → writes the final patch to round-N-patch.txt
 *
 * Each persona is run as a separate claude -p call. The synthesizer output
 * becomes the patch that gets written to disk.
 */
async function dispatchCouncil(round, diagDir, contextText, priorAttemptsSummary) {
  const skillDir   = path.resolve(__dirname, "..");
  const personasFile = path.join(skillDir, "references", "personas.md");
  const personasContent = safeRead(personasFile) || "";

  function extractPersona(name) {
    const sectionRegex = new RegExp(
      `## Persona: [^\\n]*\\n[\\s\\S]*?\`\`\`\\n([\\s\\S]*?)\`\`\``, "m"
    );
    // Find the right persona section
    const heading = {
      "senior-engineer": "Senior Engineer",
      "critic":          "Critic",
      "synthesizer":     "Synthesizer",
    }[name];
    if (!heading) return null;
    const re = new RegExp(
      `## Persona: ${heading}[\\s\\S]*?\`\`\`\\n([\\s\\S]*?)\`\`\``, "m"
    );
    const m = personasContent.match(re);
    return m ? m[1].trim() : null;
  }

  const patchPath    = path.join(diagDir, `round-${round}-patch.txt`);
  const decisionsPath = path.join(diagDir, `round-${round}-decisions.yaml`);

  const baseContext = `
=== FAILURE CONTEXT ===
${contextText}

=== PRIOR REPAIR ATTEMPTS ===
${priorAttemptsSummary || "(none — this is the first attempt)"}

=== YOUR TASK ===
Make the Playwright tests pass with the smallest possible change.
- Prefer fixing the page over fixing the test.
- Fix the test assertion ONLY if the design spec supports it (document why).
- Do NOT run npm install, do NOT modify package.json or any lock file.
- If you suspect a stale .next/ cache, write the file \`e2e/_diag/RESTART_DEV\`
  (empty file) and the orchestrator will restart the dev server.
- Available tools: Bash, Read, Edit, Write only.
`;

  // 1 — Senior Engineer proposes a patch
  const sePersona = extractPersona("senior-engineer") ||
    "You are a Senior Engineer. Diagnose the failing tests and propose a minimal patch.";

  const sePrompt = `${baseContext}

As Senior Engineer, propose the most likely root cause and the minimal patch.
Output your analysis and the proposed code changes.`;

  const seResult = dispatchSingleAgent(
    "claude-sonnet-4-6",
    sePersona,
    sePrompt,
    600000,
  );
  const seProposal = seResult.ok ? seResult.text : `(senior-engineer failed: ${seResult.error})`;

  // 2 — Critic tears it apart
  const criticPersona = extractPersona("critic") ||
    "You are the Critic. Identify problems in the proposed patch.";

  const criticPrompt = `${baseContext}

SENIOR ENGINEER PROPOSAL:
${seProposal}

As Critic, tear apart this proposal. What assumptions break? What edge cases are missed? What might make things worse?`;

  const criticResult = dispatchSingleAgent(
    "claude-sonnet-4-6",
    criticPersona,
    criticPrompt,
    600000,
  );
  const criticOutput = criticResult.ok ? criticResult.text : `(critic failed: ${criticResult.error})`;

  // 3 — Synthesizer reconciles and applies the patch
  const synthPersona = extractPersona("synthesizer") ||
    "You are the Synthesizer. Reconcile the proposals into a final patch.";

  const synthPrompt = `${baseContext}

SENIOR ENGINEER PROPOSAL:
${seProposal}

CRITIC ANALYSIS:
${criticOutput}

As Synthesizer, reconcile into ONE minimal patch. Then:
1. Actually apply the patch using the Edit/Write/Bash tools available to you.
2. Write the applied diff (or a note "test-assertion weakened: <justification>")
   to: ${patchPath}
3. Write the deliberation summary (decisions_log YAML) to: ${decisionsPath}
4. Output ONLY "ok" or "err:<reason>" as your last line.`;

  const synthResult = dispatchSingleAgent(
    "claude-sonnet-4-6",
    synthPersona,
    synthPrompt,
    900000,
  );

  // Extract terminal status from synthesizer output
  const synthText = (synthResult.ok ? synthResult.text : "").trim();
  const lastLine  = synthText.split("\n").pop().trim();
  const status    = (lastLine === "ok" || lastLine.startsWith("err:"))
    ? lastLine
    : (synthResult.ok ? "ok" : `err:council_synth_failed:${synthResult.error}`);

  return status;
}

// ── Build failure-report markdown ────────────────────────────────────────

function buildFailureReport(diagDir, maxRounds, finalResult) {
  const lines = [
    "# PHASE4-FAILURE-REPORT",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "All repair tiers exhausted. Human review required.",
    "",
    `Final test result: ${finalResult.passed}/${finalResult.total} passed, ${finalResult.failed} failing`,
    "",
  ];

  for (let r = 0; r < maxRounds; r++) {
    const ctxPath   = path.join(diagDir, `round-${r}.txt`);
    const patchPath = path.join(diagDir, `round-${r}-patch.txt`);
    const resPath   = path.join(diagDir, `round-${r}-results.txt`);

    if (!fs.existsSync(ctxPath)) break;   // rounds beyond the last run

    lines.push(`---`);
    lines.push(`## Round ${r}`);
    lines.push("");

    const ctx = safeRead(ctxPath);
    if (ctx) {
      lines.push("### Failure Context");
      lines.push("```");
      lines.push(ctx.slice(0, 3000));
      lines.push("```");
      lines.push("");
    }

    const patch = safeRead(patchPath);
    if (patch) {
      lines.push("### Applied Patch");
      lines.push("```");
      lines.push(patch.slice(0, 2000));
      lines.push("```");
      lines.push("");
    }

    const res = safeRead(resPath);
    if (res) {
      lines.push("### Post-Patch Results");
      lines.push("```");
      lines.push(res.slice(0, 2000));
      lines.push("```");
      lines.push("");
    }
  }

  return lines.join("\n") + "\n";
}

// ── Tier label helper ────────────────────────────────────────────────────

function tierLabel(round) {
  if (round <= 1) return `Tier 1 (Sonnet, round ${round})`;
  if (round === 2) return `Tier 2 (Opus, round ${round})`;
  if (round === 3) return `Tier 3 (Council, round ${round})`;
  return `Tier 4 (exhausted)`;
}

// ── Build repair system prompt per tier ───────────────────────────────────

function buildRepairSystemPrompt(round) {
  const skillDir     = path.resolve(__dirname, "..");
  const personasFile = path.join(skillDir, "references", "personas.md");
  const content      = safeRead(personasFile) || "";

  // Extract "Coder" persona as base for Tier 1/2 repair agents
  const coderMatch = content.match(
    /## Persona: Coder[\\s\\S]*?```\n([\s\S]*?)```/m
  );
  const coderPersona = coderMatch ? coderMatch[1].trim() : null;

  if (coderPersona) {
    return `${coderPersona}

REPAIR MODE:
You are fixing failing Playwright E2E tests. Use Bash, Read, Edit, and Write tools.
Do NOT install packages. Do NOT modify package.json or lock files.
If you suspect a stale build cache, write an empty file at e2e/_diag/RESTART_DEV.
Write the applied patch (diff or description) to the patch file specified in the task.
Your final output line must be exactly "ok" or "err:<reason>".`;
  }

  return `You are a senior software engineer fixing failing E2E tests.
Use only Bash, Read, Edit, and Write tools. No npm install.
If stale cache is suspected, write e2e/_diag/RESTART_DEV.
Write the patch to the specified file. Final line: "ok" or "err:<reason>".`;
}

// ── Build prior-attempts summary ──────────────────────────────────────────

function buildPriorAttemptsSummary(diagDir, currentRound) {
  const lines = [];
  for (let r = 0; r < currentRound; r++) {
    const patchPath = path.join(diagDir, `round-${r}-patch.txt`);
    const resPath   = path.join(diagDir, `round-${r}-results.txt`);
    const patchContent = safeRead(patchPath);
    const resContent   = safeRead(resPath);

    if (patchContent || resContent) {
      lines.push(`Round ${r} (${tierLabel(r)}):`);
      if (patchContent) {
        lines.push("  Patch attempted:");
        lines.push("  " + patchContent.slice(0, 500).split("\n").join("\n  "));
      }
      if (resContent) {
        // Pull out the summary line only
        const summary = resContent.split("\n").find(l => /passed|failed/i.test(l)) || "";
        lines.push(`  Result: ${summary.trim()}`);
      }
    }
  }
  return lines.join("\n") || "(none)";
}

// ── Main orchestration loop ───────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const { e2eDir, appDir, appPort, pidFile, outputFile, maxRounds, diagDir } = args;

  fs.mkdirSync(diagDir, { recursive: true });

  // Determine starting round (idempotent resume: skip rounds with existing diag files)
  let startRound = 0;
  for (let r = 0; r < maxRounds; r++) {
    if (fs.existsSync(path.join(diagDir, `round-${r}-results.txt`))) {
      startRound = r + 1;
    } else {
      break;
    }
  }

  // ── Initial test run ──────────────────────────────────────────────────
  // If we are resuming from a partially completed run, re-run tests to get
  // current state rather than trusting the last results file.
  let currentRun = runPlaywright(e2eDir, appPort);

  // If all tests pass on entry (or after resume), we are done.
  if (currentRun.exitCode === 0 && currentRun.failed === 0) {
    console.log(`ok:rounds=0,passed=${currentRun.passed}/${currentRun.total}`);
    process.exit(0);
  }

  let prevFailed = currentRun.failed || Infinity;

  // ── Main loop ─────────────────────────────────────────────────────────
  for (let round = startRound; round < maxRounds; round++) {

    // ── Tier 4: exhausted ──
    if (round >= 4) {
      const report = buildFailureReport(diagDir, maxRounds, currentRun);
      safeWrite(outputFile, report);
      console.log(`err:exhausted — failure report written to ${outputFile}`);
      maybeRecover(args);
      process.exit(0);
    }

    // 1. Capture context
    const ctxPath = captureContext(round, diagDir, e2eDir, appPort, appDir, currentRun);
    const contextText = safeRead(ctxPath) || "(context unavailable)";

    // 2. Snapshot files (for regression revert)
    const snapshot = snapshotFiles(appDir);

    // 3. Build repair prompt
    const patchPath     = path.join(diagDir, `round-${round}-patch.txt`);
    const priorSummary  = buildPriorAttemptsSummary(diagDir, round);
    const systemPrompt  = buildRepairSystemPrompt(round);

    let repairStatus;

    if (round <= 1) {
      // ── Tier 1: Sonnet single-agent ──────────────────────────────────
      const userMessage = `
=== FAILURE CONTEXT ===
${contextText}

=== PRIOR REPAIR ATTEMPTS ===
${priorSummary}

=== YOUR TASK ===
Make the Playwright E2E tests pass with the smallest possible change.
Prefer fixing the page source over fixing the test assertion.
Fix the test assertion ONLY if the design spec indicates the test is wrong
(document the reason).
Do NOT run npm install or modify package.json / lock files.
If you suspect a stale .next/ cache, write an empty file:
  ${path.join(diagDir, "RESTART_DEV")}
and the orchestrator will restart the dev server.

After making changes, write the applied diff or a short description of the
change to: ${patchPath}

Final output line (stdout): exactly "ok" or "err:<reason>".
Tools available: Bash, Read, Edit, Write only.
`;
      const model  = "e2e_chase_tier1";
      const result = dispatchSingleAgent(model, systemPrompt, userMessage);
      const text   = (result.ok ? result.text : "").trim();
      const last   = text.split("\n").pop().trim();
      repairStatus = (last === "ok" || last.startsWith("err:"))
        ? last
        : (result.ok ? "ok" : `err:agent_failed:${result.error}`);

    } else if (round === 2) {
      // ── Tier 2: Opus single-agent ─────────────────────────────────────
      const opusPrior = priorSummary
        ? `Prior Sonnet rounds were attempted but did not fix the issue:\n${priorSummary}\n\nDo not repeat those approaches. Consider whether the failure stems from something Sonnet missed: cross-file contract drift, undocumented component prop, stale build cache, missing prerender directive.`
        : "";

      const userMessage = `
=== FAILURE CONTEXT ===
${contextText}

${opusPrior}

=== YOUR TASK ===
Make the Playwright E2E tests pass with the smallest possible change.
Prefer fixing the page source over fixing the test assertion.
Fix the test assertion ONLY if the design spec indicates the test is wrong
(document the reason).
Do NOT run npm install or modify package.json / lock files.
If you suspect a stale .next/ cache, write an empty file:
  ${path.join(diagDir, "RESTART_DEV")}
and the orchestrator will restart the dev server.

After making changes, write the applied diff or a short description of the
change to: ${patchPath}

Final output line (stdout): exactly "ok" or "err:<reason>".
Tools available: Bash, Read, Edit, Write only.
`;
      const model  = "e2e_chase_tier2";
      const result = dispatchSingleAgent(model, systemPrompt, userMessage, 1200000);
      const text   = (result.ok ? result.text : "").trim();
      const last   = text.split("\n").pop().trim();
      repairStatus = (last === "ok" || last.startsWith("err:"))
        ? last
        : (result.ok ? "ok" : `err:agent_failed:${result.error}`);

    } else if (round === 3) {
      // ── Tier 3: Council ───────────────────────────────────────────────
      repairStatus = await dispatchCouncil(round, diagDir, contextText, priorSummary);
    }

    // 4. Handle RESTART_DEV sentinel before re-running tests
    await maybeRestartDev(diagDir, pidFile, appDir, appPort);

    // 5. Re-run tests
    currentRun = runPlaywright(e2eDir, appPort);
    const resultsText = `Round ${round} post-patch results:\n${currentRun.output}`;
    safeWrite(path.join(diagDir, `round-${round}-results.txt`), resultsText);

    // 6. Check for green
    if (currentRun.exitCode === 0 && currentRun.failed === 0) {
      console.log(`ok:rounds=${round + 1},passed=${currentRun.passed}/${currentRun.total}`);
      process.exit(0);
    }

    // 7. Regression check — if failing count increased, revert and skip to next tier
    if (currentRun.failed > prevFailed) {
      // Revert all source file changes
      restoreSnapshot(snapshot);
      // Log the regression event in the patch file if not already written
      if (!fs.existsSync(patchPath)) {
        safeWrite(patchPath, `Round ${round}: regression detected (${currentRun.failed} failing > ${prevFailed} prior). Reverted.`);
      } else {
        const existingPatch = safeRead(patchPath) || "";
        safeWrite(patchPath, existingPatch + `\n\nREGRESSION: ${currentRun.failed} failing after patch (was ${prevFailed}). Reverted.`);
      }
      // Advance to next round without updating prevFailed
    } else {
      prevFailed = currentRun.failed;
    }
  }

  // Fell through max rounds without success
  const report = buildFailureReport(diagDir, maxRounds, currentRun);
  safeWrite(outputFile, report);
  console.log(`err:exhausted — failure report written to ${outputFile}`);
  maybeRecover(args);
  process.exit(0);
}

main().catch(e => {
  console.log(`err:uncaught:${e.message}`);
  process.exit(1);
});
