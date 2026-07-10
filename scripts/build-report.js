#!/usr/bin/env node
/**
 * build-report.js — Assembles the final Markdown build report from all phase
 * outputs: manifest validation gates, static verification, E2E results,
 * screenshots, and a summary of what was built.
 *
 * Usage:
 *   node build-report.js \
 *     --output-dir <dir> \
 *     --manifest-dir <dir> \
 *     [--title "My App Build Report"]
 *
 * Writes:
 *   <output-dir>/wiki/BUILD-REPORT.md
 *
 * Returns "ok:report=<path>" or "err:[description]"
 */

const fs   = require("fs");
const path = require("path");

// ── CLI args ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { title: "HPC Build Report" };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--output-dir":     parsed.outputDir     = args[++i]; break;
      case "--manifest-dir":   parsed.manifestDir   = args[++i]; break;
      case "--title":          parsed.title         = args[++i]; break;
      case "--phase4-skipped": parsed.phase4Skipped = args[++i]; break;
    }
  }
  return parsed;
}

// ── Data readers ──────────────────────────────────────────────────────────

function safeRead(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return fs.readFileSync(filePath, "utf-8"); }
  catch { return null; }
}

function safeJson(filePath) {
  const c = safeRead(filePath);
  if (!c) return null;
  try { return JSON.parse(c); }
  catch { return null; }
}

/**
 * Parse a YAML file into a flat key→value map (depth-1 only).
 */
function parseYamlFlat(content) {
  const result = {};
  if (!content) return result;
  for (const line of content.split("\n")) {
    const m = line.match(/^(\w[\w_-]*):\s*(.+)$/);
    if (m) result[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return result;
}

// ── Store status parser ───────────────────────────────────────────────────

function readStoreStatus(outputDir) {
  const statePath = path.join(outputDir, "store", "state.json");
  const state = safeJson(statePath);
  if (!state || !state.tasks) return null;

  const counts = {};
  for (const t of Object.values(state.tasks)) {
    counts[t.status] = (counts[t.status] || 0) + 1;
  }
  return { total: Object.keys(state.tasks).length, counts };
}

// ── Manifest stats ────────────────────────────────────────────────────────

function readManifestStats(manifestDir) {
  if (!manifestDir || !fs.existsSync(manifestDir)) return null;

  const stats = { epics: 0, tasks: 0, contracts: 0 };

  const epicsDir = path.join(manifestDir, "epics");
  if (fs.existsSync(epicsDir)) {
    stats.epics = fs.readdirSync(epicsDir).filter(f => f.endsWith(".yaml")).length;
  }

  const tasksDir = path.join(manifestDir, "tasks");
  if (fs.existsSync(tasksDir)) {
    stats.tasks = fs.readdirSync(tasksDir).filter(f => f.endsWith(".yaml")).length;
  }

  const contractsDir = path.join(manifestDir, "contracts");
  if (fs.existsSync(contractsDir)) {
    stats.contracts = fs.readdirSync(contractsDir).filter(f => f.endsWith(".yaml")).length;
  }

  return stats;
}

// ── Output file stats ─────────────────────────────────────────────────────

function readOutputStats(outputDir) {
  const outDir = path.join(outputDir, "output");
  if (!fs.existsSync(outDir)) return null;

  let count = 0;
  const exts = {};

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        count++;
        const ext = path.extname(entry.name).toLowerCase() || "(none)";
        exts[ext] = (exts[ext] || 0) + 1;
      }
    }
  }

  try { walk(outDir); } catch {}
  return { count, exts };
}

// ── Verify-build report reader ────────────────────────────────────────────

function readVerifyReport(outputDir) {
  const p = path.join(outputDir, "wiki", "verification-report.yaml");
  const content = safeRead(p);
  if (!content) return null;
  const result = parseYamlFlat(content);
  // verify-build.js emits flat `all_green:`/`failure_count:` keys (picked up
  // by parseYamlFlat above) plus a nested `phases:` list of
  // `- name: <phase>` / `status: pass|fail|skipped` entries — derive the
  // per-phase `<phase>_ok` keys the detail table reads from that list.
  let phaseName = null;
  for (const line of content.split("\n")) {
    const nameM = line.match(/^\s+-\s+name:\s*(.+)$/);
    if (nameM) { phaseName = nameM[1].trim(); continue; }
    const statusM = line.match(/^\s+status:\s*(.+)$/);
    if (statusM && phaseName) {
      const status = statusM[1].trim();
      if (status === "pass")      result[`${phaseName}_ok`] = "true";
      else if (status === "fail") result[`${phaseName}_ok`] = "false";
      phaseName = null;
    }
  }
  return result;
}

// ── E2E report reader ─────────────────────────────────────────────────────

function readE2EReport(outputDir) {
  const p = path.join(outputDir, "wiki", "e2e-report.yaml");
  const content = safeRead(p);
  if (!content) return null;

  const result = {
    passed: 0, failed: 0, skipped: 0,
    all_green: false, app_url: "", duration_ms: 0,
    failures: [], screenshots: [],
  };

  let inFailures = false, inScreenshots = false;
  for (const line of content.split("\n")) {
    if (line.startsWith("failures:"))    { inFailures = true; inScreenshots = false; continue; }
    if (line.startsWith("screenshots:")) { inScreenshots = true; inFailures = false; continue; }
    if (/^\w/.test(line) && !line.startsWith(" ") && !line.startsWith("-")) {
      inFailures = false; inScreenshots = false;
    }

    if (inScreenshots) {
      const m = line.match(/^\s+-\s+(.+)$/);
      if (m) result.screenshots.push(m[1].trim());
    } else if (inFailures) {
      const mTitle = line.match(/^\s+title:\s+"(.+)"$/);
      if (mTitle) result.failures.push({ title: mTitle[1] });
    } else {
      const kv = line.match(/^(passed|failed|skipped|all_green|app_url|duration_ms):\s*(.+)$/);
      if (kv) {
        const [, k, v] = kv;
        if (k === "all_green") result[k] = v.trim() === "true";
        else if (k === "passed" || k === "failed" || k === "skipped" || k === "duration_ms") result[k] = parseInt(v, 10) || 0;
        else result[k] = v.replace(/^["']|["']$/g, "");
      }
    }
  }

  return result;
}

// ── Acceptance report reader (Phase 5 — M6) ───────────────────────────────
//
// ACCEPTANCE-REPORT.md is written at the workspace root by acceptance-run.js.
// We extract the verdict + summary counts for the build report's overall status.
function readAcceptanceReport(outputDir) {
  const candidates = [
    path.join(outputDir, "ACCEPTANCE-REPORT.md"),
    path.join(outputDir, "..", "ACCEPTANCE-REPORT.md"),
  ];
  for (const p of candidates) {
    const content = safeRead(p);
    if (!content) continue;
    const verdict = (content.match(/^\*\*Verdict:\*\*\s*(PASS|FAIL)/m) || [])[1] || null;
    const evaluated = parseInt((content.match(/Criteria evaluated:\s*(\d+)/) || [])[1] || "0", 10);
    const passed = parseInt((content.match(/^-?\s*Passed:\s*(\d+)/m) || [])[1] || "0", 10);
    const failed = parseInt((content.match(/^-?\s*Failed:\s*(\d+)/m) || [])[1] || "0", 10);
    return { verdict, evaluated, passed, failed, path: p };
  }
  return null;
}

// ── Infra summary ─────────────────────────────────────────────────────────

function readInfraSummary(manifestDir) {
  const p = path.join(manifestDir, "infra-requirements.yaml");
  const content = safeRead(p);
  if (!content) return null;

  const result = { framework: null, services: [] };
  let inDatabases = false, inCache = false;

  for (const line of content.split("\n")) {
    if (/^framework:/.test(line)) { inDatabases = false; inCache = false; continue; }
    if (/^databases:/.test(line)) { inDatabases = true; inCache = false; continue; }
    if (/^cache:/.test(line))     { inCache = true; inDatabases = false; continue; }
    if (/^(auth|storage|emulator|env_vars):/.test(line)) { inDatabases = false; inCache = false; continue; }

    const typeLine = line.match(/^\s{2}type:\s*(.+)$/);
    if (typeLine) {
      if (!inDatabases && !inCache) result.framework = typeLine[1].trim();
      else result.services.push(typeLine[1].trim());
    }
  }

  return result;
}

// ── Screenshot section ────────────────────────────────────────────────────

function screenshotSection(screenshotsDir, e2eScreenshots) {
  if (!fs.existsSync(screenshotsDir)) return "";

  const all = fs.readdirSync(screenshotsDir)
    .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .sort();

  if (all.length === 0) return "";

  const lines = ["\n## Screenshots\n"];
  for (const name of all) {
    const label = name
      .replace(/\.(png|jpg|jpeg|webp)$/, "")
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, c => c.toUpperCase());
    lines.push(`### ${label}\n`);
    lines.push(`![${label}](../screenshots/${name})\n`);
  }
  return lines.join("\n");
}

// ── Status badge helpers ──────────────────────────────────────────────────

function badge(ok, okText, failText) {
  return ok ? `✅ ${okText}` : `❌ ${failText}`;
}

// ── Date formatter ────────────────────────────────────────────────────────

function formatDate(d) {
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

// ── Report assembler ──────────────────────────────────────────────────────

function buildReport(args) {
  const {
    outputDir, manifestDir, title,
    storeStatus, manifestStats, outputStats,
    verifyReport, e2eReport, infraSummary,
    phase4Skipped, acceptanceReport,
  } = args;

  const generatedAt = formatDate(new Date());

  // ── Overall status ──────────────────────────────────────────────────
  const staticOk = verifyReport ? verifyReport.all_green === "true" : null;
  const e2eOk    = e2eReport    ? e2eReport.all_green              : null;
  const acceptanceOk = acceptanceReport && acceptanceReport.verdict
    ? acceptanceReport.verdict === "PASS"
    : null;
  const allTasksComplete = storeStatus
    ? (storeStatus.counts["COMPLETE"] || 0) === storeStatus.total
    : null;

  // Acceptance is the authoritative final gate (M6): a FAIL verdict makes the
  // whole build not-ok regardless of earlier green phases.
  const overallOk = (allTasksComplete !== false) &&
    (staticOk !== false) &&
    (e2eOk !== false) &&
    (acceptanceOk !== false);

  // ── Header ──────────────────────────────────────────────────────────
  const lines = [
    `# ${title}`,
    "",
    `> Generated: ${generatedAt}`,
    "",
    `## Overall Status`,
    "",
    `| Stage | Result |`,
    `|-------|--------|`,
  ];

  if (allTasksComplete !== null) {
    const complete = storeStatus.counts["COMPLETE"] || 0;
    const blocked  = storeStatus.counts["BLOCKED"]  || 0;
    const planned  = storeStatus.counts["PLANNED"]  || 0;
    const label = allTasksComplete
      ? `All ${complete} tasks complete`
      : `${complete}/${storeStatus.total} complete, ${blocked} blocked, ${planned} remaining`;
    lines.push(`| Worker Execution | ${badge(allTasksComplete, label, label)} |`);
  }

  if (staticOk !== null) {
    const fc = verifyReport.failure_count || "0";
    lines.push(`| Static Verification | ${badge(staticOk, "Passed", `${fc} failure(s)`)} |`);
  }

  if (e2eOk !== null) {
    lines.push(`| E2E Tests | ${badge(e2eOk, `${e2eReport.passed} passed`, `${e2eReport.failed} failed`)} |`);
  }

  if (phase4Skipped) {
    lines.push(`| Runtime Verification | ⚠️ Skipped — ${phase4Skipped} |`);
  } else if (!e2eReport) {
    lines.push(`| Runtime Verification | ⏭️ Not run |`);
  }

  if (acceptanceOk !== null) {
    const a = acceptanceReport;
    const label = acceptanceOk ? `PASS — ${a.passed}/${a.evaluated} criteria` : `FAIL — ${a.failed}/${a.evaluated} criteria failed`;
    lines.push(`| Acceptance (M6) | ${badge(acceptanceOk, label, label)} |`);
  } else {
    lines.push(`| Acceptance (M6) | ⏭️ Not run |`);
  }

  lines.push("", "---", "");

  // ── Phase 4 skipped notice ──────────────────────────────────────────
  if (phase4Skipped) {
    lines.push("## Phase 4: Runtime Verification");
    lines.push("");
    lines.push(`⚠️ **Skipped** — ${phase4Skipped}`);
    lines.push("");
    lines.push("The Phase 3 build is complete. To run Phase 4:");
    lines.push("1. Ensure the required tooling is installed (see `manifest/infra-requirements.yaml`)");
    lines.push("2. Re-run from Step 17: `node scripts/emulator-start.js --manifest-dir manifest/ --output-dir .`");
    lines.push("");
  }

  // ── Manifest stats ──────────────────────────────────────────────────
  if (manifestStats) {
    lines.push("## Manifest");
    lines.push("");
    lines.push(`- **Epics:** ${manifestStats.epics}`);
    lines.push(`- **Tasks:** ${manifestStats.tasks}`);
    lines.push(`- **Contracts:** ${manifestStats.contracts}`);
    lines.push("");
  }

  // ── Output files ────────────────────────────────────────────────────
  if (outputStats) {
    lines.push("## Output Files");
    lines.push("");
    lines.push(`**Total files produced:** ${outputStats.count}`);
    lines.push("");
    if (Object.keys(outputStats.exts).length > 0) {
      lines.push("| Extension | Count |");
      lines.push("|-----------|-------|");
      for (const [ext, cnt] of Object.entries(outputStats.exts).sort((a, b) => b[1] - a[1])) {
        lines.push(`| \`${ext}\` | ${cnt} |`);
      }
      lines.push("");
    }
  }

  // ── Infrastructure ──────────────────────────────────────────────────
  if (infraSummary) {
    lines.push("## Infrastructure");
    lines.push("");
    if (infraSummary.framework) lines.push(`- **Framework:** \`${infraSummary.framework}\``);
    if (infraSummary.services.length > 0) {
      lines.push(`- **Emulated services:** ${infraSummary.services.map(s => `\`${s}\``).join(", ")}`);
    }
    lines.push("");
  }

  // ── Static verification detail ───────────────────────────────────────
  if (verifyReport) {
    lines.push("## Static Verification");
    lines.push("");
    lines.push(`| Phase | Result |`);
    lines.push(`|-------|--------|`);
    const phases = ["typecheck", "build", "test"];
    for (const phase of phases) {
      const key = `${phase}_ok`;
      if (verifyReport[key] !== undefined) {
        lines.push(`| ${phase} | ${badge(verifyReport[key] === "true", "Passed", "Failed")} |`);
      }
    }
    lines.push("");
  }

  // ── E2E detail ───────────────────────────────────────────────────────
  if (e2eReport) {
    lines.push("## E2E Test Results");
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Passed | ${e2eReport.passed} |`);
    lines.push(`| Failed | ${e2eReport.failed} |`);
    lines.push(`| Skipped | ${e2eReport.skipped} |`);
    if (e2eReport.duration_ms > 0) {
      lines.push(`| Duration | ${(e2eReport.duration_ms / 1000).toFixed(1)}s |`);
    }
    lines.push("");

    if (e2eReport.failures.length > 0) {
      lines.push("### Failures");
      lines.push("");
      for (const f of e2eReport.failures) {
        lines.push(`- **${f.title}**`);
      }
      lines.push("");
    }
  }

  // ── Acceptance detail (M6) ────────────────────────────────────────────
  if (acceptanceReport && acceptanceReport.verdict) {
    lines.push("## Acceptance (M6)");
    lines.push("");
    lines.push(`**Verdict:** ${acceptanceReport.verdict}`);
    lines.push("");
    lines.push(`- Criteria evaluated: ${acceptanceReport.evaluated}`);
    lines.push(`- Passed: ${acceptanceReport.passed}`);
    lines.push(`- Failed: ${acceptanceReport.failed}`);
    lines.push(`- Full report: \`${path.basename(acceptanceReport.path)}\``);
    lines.push("");
  }

  // ── Screenshots ──────────────────────────────────────────────────────
  const screenshotsDir = path.join(outputDir, "screenshots");
  const e2eScreenshots = e2eReport ? e2eReport.screenshots : [];
  const screenshotMd = screenshotSection(screenshotsDir, e2eScreenshots);
  if (screenshotMd) lines.push(screenshotMd);

  // ── Footer ───────────────────────────────────────────────────────────
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("*Report generated by [HPC](https://github.com/openclaw/hpc-skill)*");

  return lines.join("\n") + "\n";
}

// ── Main ──────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs();

  if (!args.outputDir) {
    console.log("err:usage: node build-report.js --output-dir <dir> --manifest-dir <dir>");
    process.exit(0);
  }

  const wikiDir = path.join(args.outputDir, "wiki");
  fs.mkdirSync(wikiDir, { recursive: true });

  const storeStatus   = readStoreStatus(args.outputDir);
  const manifestStats = args.manifestDir ? readManifestStats(args.manifestDir) : null;
  const outputStats   = readOutputStats(args.outputDir);
  const verifyReport  = readVerifyReport(args.outputDir);
  const e2eReport     = readE2EReport(args.outputDir);
  const infraSummary  = args.manifestDir ? readInfraSummary(args.manifestDir) : null;
  const acceptanceReport = readAcceptanceReport(args.outputDir);

  const reportMd = buildReport({
    outputDir:     args.outputDir,
    manifestDir:   args.manifestDir,
    title:         args.title,
    storeStatus,
    manifestStats,
    outputStats,
    verifyReport,
    e2eReport,
    infraSummary,
    phase4Skipped: args.phase4Skipped,
    acceptanceReport,
  });

  const reportPath = path.join(wikiDir, "BUILD-REPORT.md");
  fs.writeFileSync(reportPath, reportMd);

  console.log(`ok:report=${reportPath}`);
}

main();
