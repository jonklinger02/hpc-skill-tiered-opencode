#!/usr/bin/env node
/**
 * verify-build.js
 *
 * Phase 3 entry point. After assemble.js confirms structural completeness,
 * this script runs the project's actual build commands (typecheck → compile
 * → test) against the output directory and writes a structured failure
 * report for triage-failures.js to consume.
 *
 * Command discovery order:
 *   1. --build-commands <file> CLI arg (explicit override)
 *   2. <manifestDir>/build-commands.yaml (manifest-level override)
 *   3. Auto-detection from <outputDir> (package.json, pyproject.toml,
 *      Cargo.toml, go.mod)
 *
 * Per-phase failure attribution: stderr is scanned for file paths matching
 * any task's file_path, and the first match is recorded along with the
 * corresponding task_id. Best-effort — if no match, the failure is recorded
 * unattributed and the triage layer decides what to do with it.
 *
 * Always writes <wikiDir>/verification-report.yaml. Exit code is 0 if the
 * report was written successfully (regardless of whether verification
 * passed); the report's `all_green` field is the authoritative pass/fail
 * signal for the orchestrator.
 *
 * Usage:
 *   node verify-build.js \
 *     --output-dir <dir> \
 *     --manifest-dir <dir> \
 *     --wiki-dir <dir> \
 *     [--build-commands <file>] \
 *     [--skip typecheck,test] \
 *     [--cwd <dir>]   # default: <output-dir>
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function parseArgs() {
  const a = { skip: new Set() };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--output-dir": a.outputDir = argv[++i]; break;
      case "--manifest-dir": a.manifestDir = argv[++i]; break;
      case "--wiki-dir": a.wikiDir = argv[++i]; break;
      case "--build-commands": a.buildCommands = argv[++i]; break;
      case "--cwd": a.cwd = argv[++i]; break;
      case "--skip": for (const p of argv[++i].split(",")) a.skip.add(p.trim()); break;
    }
  }
  return a;
}

const args = parseArgs();
if (!args.outputDir || !args.manifestDir || !args.wikiDir) {
  console.log("err:missing required args (--output-dir --manifest-dir --wiki-dir)");
  process.exit(1);
}

const cwd = args.cwd || args.outputDir;

// ── Command discovery ────────────────────────────────────────────────────

function loadCommandsFile(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf-8");
  const get = (k) => {
    const m = text.match(new RegExp(`^${k}:\\s*"?([^"\\n]+)"?\\s*$`, "m"));
    return m ? m[1].trim().replace(/^"|"$/g, "") : null;
  };
  // required_phases: a YAML list (inline `[a, b]` or block) naming phases that
  // MUST run green. A required phase that is skipped (null command / user-skip)
  // counts as a build failure. Absent → no phase is required (legacy behavior).
  const reqPhases = (() => {
    const inline = text.match(/^required_phases:\s*\[([^\]]*)\]/m);
    if (inline) return inline[1].split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    const block = text.match(/^required_phases:\s*\n((?:\s+-\s*.+\n?)*)/m);
    if (block) return (block[1].match(/^\s+-\s*.+/gm) || []).map(l => l.replace(/^\s+-\s*/, "").trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    return [];
  })();
  return {
    typecheck: get("typecheck"),
    build: get("build"),
    test: get("test"),
    boot_smoke: get("boot_smoke"),
    required_phases: reqPhases,
    project_type: get("project_type") || "manifest-override",
  };
}

// Read declared tech_stack roles from manifest.yaml (regex, no yaml dep).
// boot_smoke is mandatory whenever the stack declares a runnable surface.
const RUNNABLE_ROLES = ["api_server", "web_ui", "ssr_app", "cli"];
function bootSmokeRequiredFromStack(manifestDir) {
  try {
    const mf = path.join(manifestDir, "manifest.yaml");
    if (!fs.existsSync(mf)) return false;
    const roles = (fs.readFileSync(mf, "utf-8").match(/^\s*role:\s*"?([\w-]+)"?/gm) || [])
      .map(l => (l.match(/role:\s*"?([\w-]+)"?/) || [])[1]);
    return roles.some(r => RUNNABLE_ROLES.includes(r));
  } catch { return false; }
}

function detectFromOutputDir(dir) {
  if (fs.existsSync(path.join(dir, "package.json"))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
    const scripts = pkg.scripts || {};
    return {
      project_type: "node",
      typecheck: scripts.typecheck || (fs.existsSync(path.join(dir, "tsconfig.json")) ? "npx tsc --noEmit" : null),
      build: scripts.build || null,
      test: scripts.test ? "npm test --silent" : null,
      boot_smoke: null,
      required_phases: [],
    };
  }
  if (fs.existsSync(path.join(dir, "pyproject.toml")) || fs.existsSync(path.join(dir, "setup.py"))) {
    return {
      project_type: "python",
      typecheck: "python -m mypy . --ignore-missing-imports || true",
      build: "python -m compileall -q .",
      test: "python -m pytest -q",
    };
  }
  if (fs.existsSync(path.join(dir, "requirements.txt"))) {
    return {
      project_type: "python-requirements",
      typecheck: null,
      build: "python -m compileall -q .",
      test: fs.existsSync(path.join(dir, "tests")) || fs.existsSync(path.join(dir, "test")) ? "python -m pytest -q" : null,
    };
  }
  if (fs.existsSync(path.join(dir, "Cargo.toml"))) {
    return {
      project_type: "rust",
      typecheck: "cargo check --quiet",
      build: "cargo build --quiet",
      test: "cargo test --quiet",
    };
  }
  if (fs.existsSync(path.join(dir, "go.mod"))) {
    return {
      project_type: "go",
      typecheck: "go vet ./...",
      build: "go build ./...",
      test: "go test ./...",
    };
  }
  return { project_type: "unknown", typecheck: null, build: null, test: null };
}

let cmds = null;
let cmdsSource = null;
if (args.buildCommands && fs.existsSync(args.buildCommands)) {
  cmds = loadCommandsFile(args.buildCommands);
  cmdsSource = `cli:${args.buildCommands}`;
} else {
  const manifestOverride = path.join(args.manifestDir, "build-commands.yaml");
  if (fs.existsSync(manifestOverride)) {
    cmds = loadCommandsFile(manifestOverride);
    cmdsSource = "manifest-override";
  }
}
if (!cmds) {
  cmds = detectFromOutputDir(cwd);
  cmdsSource = "auto-detect";
}

// ── Task path index for failure attribution ──────────────────────────────

function buildTaskIndex(manifestDir) {
  const tasksDir = path.join(manifestDir, "tasks");
  const idx = []; // { task_id, file_path, abs_norm }
  if (!fs.existsSync(tasksDir)) return idx;
  for (const f of fs.readdirSync(tasksDir)) {
    if (!f.endsWith(".yaml")) continue;
    const content = fs.readFileSync(path.join(tasksDir, f), "utf-8");
    const tid = content.match(/^task_id:\s*"?([^"\n]+)"?/m);
    const fp = content.match(/^file_path:\s*"?([^"\n]+)"?/m);
    if (tid && fp) {
      idx.push({
        task_id: tid[1].trim(),
        file_path: fp[1].trim(),
      });
    }
  }
  return idx;
}

const taskIndex = buildTaskIndex(args.manifestDir);

function attributeFailure(stderr, stdout) {
  const blob = `${stderr}\n${stdout}`;
  // Order longest path first so "src/foo/bar.ts" wins over "bar.ts".
  const sorted = [...taskIndex].sort((a, b) => b.file_path.length - a.file_path.length);
  for (const t of sorted) {
    if (blob.includes(t.file_path)) return t;
    const base = path.basename(t.file_path);
    if (base.length >= 6 && blob.includes(base)) return t;
  }
  return null;
}

// ── Phase runner ─────────────────────────────────────────────────────────

function runPhase(name, cmd) {
  if (!cmd || args.skip.has(name)) {
    return { name, command: cmd || null, status: "skipped", reason: args.skip.has(name) ? "user-skip" : "no-command" };
  }
  const t0 = Date.now();
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: "utf-8",
    env: process.env,
    maxBuffer: 50 * 1024 * 1024,
    timeout: 1000 * 60 * 30, // 30 min per phase
  });
  const ms = Date.now() - t0;
  const stdout = r.stdout || "";
  const stderr = r.stderr || "";
  const code = r.status === null ? -1 : r.status;
  const ok = code === 0 && !r.error;

  if (ok) {
    return { name, command: cmd, status: "ok", exit_code: 0, duration_ms: ms };
  }

  const attribution = attributeFailure(stderr, stdout);
  return {
    name,
    command: cmd,
    status: "fail",
    exit_code: code,
    duration_ms: ms,
    timed_out: r.signal === "SIGTERM" || /timed out/i.test(String(r.error || "")),
    file_path: attribution?.file_path || null,
    task_id: attribution?.task_id || null,
    stderr_excerpt: tail(stderr, 80),
    stdout_excerpt: tail(stdout, 40),
    error: r.error ? String(r.error.message || r.error).slice(0, 300) : null,
  };
}

function tail(s, n) {
  if (!s) return "";
  const lines = s.split("\n");
  if (lines.length <= n) return s;
  return lines.slice(-n).join("\n");
}

// ── Run phases ───────────────────────────────────────────────────────────

const phases = [
  runPhase("typecheck", cmds.typecheck),
  runPhase("build", cmds.build),
  runPhase("test", cmds.test),
  runPhase("boot_smoke", cmds.boot_smoke),
];

// Required-ness. A phase is required if build-commands.yaml lists it in
// `required_phases`, or — for boot_smoke specifically — if the manifest's
// tech_stack declares a runnable surface (api_server/web_ui/ssr_app/cli).
// Default: nothing is required, so a skipped phase does NOT fail the build
// (preserves legacy behavior for manifests that don't opt in).
const requiredPhases = new Set(cmds.required_phases || []);
const bootSmokeRequired = requiredPhases.has("boot_smoke") || bootSmokeRequiredFromStack(args.manifestDir);
if (bootSmokeRequired) requiredPhases.add("boot_smoke");
for (const p of phases) p.required = requiredPhases.has(p.name);

// New allGreen predicate (plan §2.2): a required phase with status "skipped"
// counts as a failure (validation theater — the phase that proves the product
// runs was never run). A failed phase always counts.
const effectiveFailures = phases.filter(p => p.status === "fail" || (p.status === "skipped" && p.required));
const failures = phases.filter(p => p.status === "fail");
const requiredSkipped = phases.filter(p => p.status === "skipped" && p.required);
const allGreen = effectiveFailures.length === 0;

// ── Write report ─────────────────────────────────────────────────────────

function yamlEscape(s) {
  if (s === null || s === undefined) return "null";
  if (typeof s === "number" || typeof s === "boolean") return String(s);
  const str = String(s);
  if (/[:\n"'#&*!|>%@`]/.test(str) || /^\s|\s$/.test(str)) {
    return JSON.stringify(str);
  }
  return str;
}

function indentBlock(text, indent) {
  return text.split("\n").map(l => indent + l).join("\n");
}

function emitPhase(p) {
  const out = [`  - name: ${p.name}`];
  out.push(`    command: ${yamlEscape(p.command)}`);
  out.push(`    status: ${p.status}`);
  out.push(`    required: ${p.required === true}`);
  if (p.exit_code !== undefined) out.push(`    exit_code: ${p.exit_code}`);
  if (p.duration_ms !== undefined) out.push(`    duration_ms: ${p.duration_ms}`);
  if (p.reason) out.push(`    reason: ${yamlEscape(p.reason)}`);
  if (p.timed_out) out.push(`    timed_out: true`);
  return out.join("\n");
}

function emitFailure(p) {
  // A required phase that was skipped (no command / user-skip) is a validation
  // gap, not a runtime failure — emit a distinct shape the triage layer reads.
  if (p.status === "skipped") {
    return [
      `  - phase: ${p.name}`,
      `    command: ${yamlEscape(p.command)}`,
      `    status: skipped`,
      `    required: true`,
      `    reason: ${yamlEscape(p.reason || "required-phase-skipped")}`,
      `    error: ${yamlEscape("required phase '" + p.name + "' was skipped — a required phase must run and pass (plan §2.2)")}`,
    ].join("\n");
  }
  const out = [`  - phase: ${p.name}`];
  out.push(`    command: ${yamlEscape(p.command)}`);
  out.push(`    exit_code: ${p.exit_code}`);
  out.push(`    file_path: ${yamlEscape(p.file_path)}`);
  out.push(`    task_id: ${yamlEscape(p.task_id)}`);
  if (p.timed_out) out.push(`    timed_out: true`);
  if (p.error) out.push(`    error: ${yamlEscape(p.error)}`);
  out.push(`    stderr_excerpt: |`);
  out.push(indentBlock(p.stderr_excerpt || "", "      "));
  if (p.stdout_excerpt && p.stdout_excerpt.trim()) {
    out.push(`    stdout_excerpt: |`);
    out.push(indentBlock(p.stdout_excerpt, "      "));
  }
  return out.join("\n");
}

const lines = [
  `verification_timestamp: "${new Date().toISOString()}"`,
  `output_dir: ${yamlEscape(args.outputDir)}`,
  `cwd: ${yamlEscape(cwd)}`,
  `commands_source: ${yamlEscape(cmdsSource)}`,
  `project_type: ${yamlEscape(cmds.project_type)}`,
  `all_green: ${allGreen}`,
  `failure_count: ${effectiveFailures.length}`,
  `phases:`,
  phases.map(emitPhase).join("\n"),
];
if (effectiveFailures.length > 0) {
  lines.push(`failures:`);
  lines.push(effectiveFailures.map(emitFailure).join("\n"));
} else {
  lines.push(`failures: []`);
}

fs.mkdirSync(args.wikiDir, { recursive: true });
const reportFile = path.join(args.wikiDir, "verification-report.yaml");
fs.writeFileSync(reportFile, lines.join("\n") + "\n");

if (allGreen) {
  console.log(`ok:verify all phases green project_type=${cmds.project_type} report=${reportFile}`);
} else {
  const names = effectiveFailures.map(f => f.status === "skipped" ? `${f.name}(required-skipped)` : f.name).join(",");
  console.log(`err:verify ${effectiveFailures.length} failure(s) in ${names} report=${reportFile}`);
}
