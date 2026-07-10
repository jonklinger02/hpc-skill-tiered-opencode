#!/usr/bin/env node
/**
 * notify-halt.js — Outbound notification for HPC halt states
 *
 * Fires ONLY on halt states. Two channels:
 *   (1) Commit the halt-report file to the workspace git repo with [HPC-HALT] prefix and push
 *   (2) POST to a webhook if configured
 *
 * Phase transitions / worker crashes do NOT notify (audit log only) —
 * this script is invoked only for halts.
 *
 * Usage:
 *   node scripts/notify-halt.js \
 *     --report <path-to-report.md>        # e.g. ACCEPTANCE-REPORT.md, SPEC-DEFECT.md, RUN-ABORTED.md
 *     --kind <PASS|FAIL|SPEC-DEFECT|SANITY-CAP|RUN-ABORTED>
 *     [--workspace <dir>]                 # git repo root; default = dirname of --report
 *     [--webhook <url>]                   # optional; also read HPC_NOTIFICATION_WEBHOOK env if unset
 *     [--no-push]                         # commit but don't push (e.g. no remote)
 *     [--dry-run]                         # do not run git or network; just report intended actions
 *
 * Output:
 *   - On success: "ok:notified kind=<KIND> commit=<sha|skipped> webhook=<status|none>"
 *   - On error: "err:<description>" + exit 1
 *   - Sidecar <report>.notify.json records channel results for audit trail
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const https = require("https");
const http = require("http");

// ── Argument Parsing ───────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    report: null,
    kind: null,
    workspace: null,
    webhook: null,
    noPush: false,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--report":
        parsed.report = args[++i];
        break;
      case "--kind":
        parsed.kind = args[++i];
        break;
      case "--workspace":
        parsed.workspace = args[++i];
        break;
      case "--webhook":
        parsed.webhook = args[++i];
        break;
      case "--no-push":
        parsed.noPush = true;
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
    }
  }

  return parsed;
}

// ── Extract subject from report ────────────────────────────────────────────

function extractSubject(reportPath) {
  try {
    const content = fs.readFileSync(reportPath, "utf-8");
    const lines = content.split("\n");
    for (const line of lines) {
      if (line.startsWith("# ")) {
        return line.substring(2).trim();
      }
    }
  } catch (e) {
    // Fall through to basename
  }
  return path.basename(reportPath);
}

// ── Get repo root via git ──────────────────────────────────────────────────

function getRepoRoot(workspace) {
  try {
    // execFileSync: no shell involved, so paths/content can't be interpreted
    const root = execFileSync(
      "git", ["-C", workspace, "rev-parse", "--show-toplevel"],
      { encoding: "utf-8" }
    ).trim();
    return root;
  } catch (e) {
    return null;
  }
}

// ── Commit report to git ───────────────────────────────────────────────────

function commitReport(root, reportPath, kind, subject, dryRun) {
  const result = {
    commit: null,
    push: null,
  };

  const reportAbs = path.resolve(reportPath);
  const reportRel = path.relative(root, reportAbs);

  // Add file (execFileSync argv form — no shell, so the subject/path can't
  // smuggle backticks/$() into a command line)
  try {
    if (!dryRun) execFileSync("git", ["-C", root, "add", reportRel]);
    result.add = "ok";
  } catch (e) {
    result.add = `failed: ${e.message}`;
  }

  // Commit
  const commitMsg = `[HPC-HALT][${kind}] ${subject}`;
  try {
    if (!dryRun) {
      execFileSync("git", ["-C", root, "commit", "-m", commitMsg]);
    }
    result.commit = "pending"; // Will get actual sha below
  } catch (e) {
    result.commit = `failed: ${e.message}`;
    return result;
  }

  // Get commit sha
  if (!dryRun) {
    try {
      const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
      result.commit = sha.substring(0, 7);
    } catch (e) {
      result.commit = "unknown";
    }
  } else {
    result.commit = "would-commit";
  }

  return result;
}

// ── Push to remote ─────────────────────────────────────────────────────────

function pushToRemote(root, noPush, dryRun) {
  if (noPush) {
    return "skipped (--no-push)";
  }

  if (dryRun) {
    return "would-push";
  }

  try {
    execFileSync("git", ["-C", root, "push"], { encoding: "utf-8" });
    return "ok";
  } catch (e) {
    return `failed: ${e.message.split("\n")[0]}`;
  }
}

// ── Send webhook notification ──────────────────────────────────────────────

function postWebhook(webhookUrl, kind, subject, reportPath, dryRun) {
  return new Promise((resolve) => {
    if (dryRun) {
      resolve("would-post");
      return;
    }

    // Read report for excerpt
    let bodyExcerpt = "";
    try {
      const content = fs.readFileSync(reportPath, "utf-8");
      bodyExcerpt = content.substring(0, 1000);
    } catch (e) {
      // Empty excerpt on error
    }

    const payload = {
      kind,
      subject,
      report_path: reportPath,
      timestamp: new Date().toISOString(),
      body_excerpt: bodyExcerpt,
    };

    const jsonData = JSON.stringify(payload);
    const url = new URL(webhookUrl);
    const isHttps = url.protocol === "https:";
    const client = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + (url.search || ""),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(jsonData),
      },
      timeout: 15000,
    };

    const req = client.request(options, (res) => {
      resolve(`${res.statusCode}`);
    });

    req.on("error", (e) => {
      resolve(`failed: ${e.message.substring(0, 50)}`);
    });

    req.on("timeout", () => {
      req.destroy();
      resolve("failed: timeout");
    });

    req.write(jsonData);
    req.end();
  });
}

// ── Write sidecar JSON ─────────────────────────────────────────────────────

function writeSidecar(reportPath, results) {
  const sidecarPath = `${reportPath}.notify.json`;
  try {
    fs.writeFileSync(sidecarPath, JSON.stringify(results, null, 2));
  } catch (e) {
    // Best effort; don't fail on sidecar write
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  // Validate inputs
  if (!opts.report) {
    console.error("err:missing --report argument");
    process.exit(1);
  }

  if (!opts.kind) {
    console.error("err:missing --kind argument");
    process.exit(1);
  }

  // Report must exist
  if (!fs.existsSync(opts.report)) {
    console.error(`err:report file not found: ${opts.report}`);
    process.exit(1);
  }

  // Derive workspace
  const workspace = opts.workspace || path.dirname(opts.report);

  // Extract subject from report
  const subject = extractSubject(opts.report);

  // Resolve webhook URL
  let webhookUrl = opts.webhook || process.env.HPC_NOTIFICATION_WEBHOOK;

  // Results object for sidecar
  const results = {
    kind: opts.kind,
    subject,
    report_path: opts.report,
    timestamp: new Date().toISOString(),
    commit: null,
    push: null,
    webhook: null,
  };

  // ── Commit channel ────────────────────────────────────────────────────

  let repoRoot = null;
  let commitSha = "skipped";

  if (!opts.dryRun || opts.dryRun) {
    // Even in dry-run, we check if git repo exists
    repoRoot = getRepoRoot(workspace);
  }

  if (repoRoot) {
    const commitResult = commitReport(repoRoot, opts.report, opts.kind, subject, opts.dryRun);
    results.commit = commitResult;

    if (commitResult.commit && !commitResult.commit.startsWith("failed")) {
      commitSha = commitResult.commit;

      // Push
      const pushResult = pushToRemote(repoRoot, opts.noPush, opts.dryRun);
      results.push = pushResult;
    }
  } else {
    results.commit = "skipped (not a git repo)";
    commitSha = "skipped";
  }

  // ── Webhook channel ──────────────────────────────────────────────────

  let webhookStatus = "none";
  if (webhookUrl) {
    webhookStatus = await postWebhook(webhookUrl, opts.kind, subject, opts.report, opts.dryRun);
    results.webhook = webhookStatus;
  }

  // ── Write sidecar ────────────────────────────────────────────────────

  writeSidecar(opts.report, results);

  // ── Success output ───────────────────────────────────────────────────

  const summary = `ok:notified kind=${opts.kind} commit=${commitSha} webhook=${webhookStatus}`;
  console.log(summary);
}

main().catch((err) => {
  console.error(`err:${err.message}`);
  process.exit(1);
});
