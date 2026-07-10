#!/usr/bin/env node
/**
 * audit-log.js — Append an autonomous-decision record to the build's audit
 * trail (`wiki/autonomous-decisions.yaml`), the operator's primary post-hoc
 * debugging artifact (plan "Cross-cutting safety rails").
 *
 * Every autonomous decision — tier escalation, workspace fork, recovery
 * trigger, halt — appends one YAML list item:
 *
 *   - timestamp: "ISO-8601"
 *     tier: "M5_TIER_3"
 *     decision: "..."
 *     triggering_signal: "..."
 *     rationale: "..."
 *     alternatives_considered: ["...", "..."]
 *
 * Used as a module (appendDecision) by execute.js + deliberate-fork.js, and as
 * a CLI for shell call-sites:
 *   node audit-log.js --workspace <ws> --tier M5_TIER_3 --decision "..." \
 *     [--signal "..."] [--rationale "..."]
 *
 * Best-effort: never throws into the caller's control flow.
 */

const fs = require("fs");
const path = require("path");

function yq(s) { return JSON.stringify(String(s == null ? "" : s)); }

// Append one decision record. `entry`: { tier, decision, triggering_signal?,
// rationale?, alternatives_considered?[], reason? }. Returns true on success.
function appendDecision(workspaceRoot, entry) {
  try {
    const wikiDir = path.join(workspaceRoot, "wiki");
    fs.mkdirSync(wikiDir, { recursive: true });
    const auditFile = path.join(wikiDir, "autonomous-decisions.yaml");
    let line = `- timestamp: ${yq(new Date().toISOString())}\n`;
    line += `  tier: ${yq(entry.tier || "ORCHESTRATOR")}\n`;
    line += `  decision: ${yq(entry.decision || "")}\n`;
    if (entry.triggering_signal != null) line += `  triggering_signal: ${yq(entry.triggering_signal)}\n`;
    if (entry.rationale != null) line += `  rationale: ${yq(entry.rationale)}\n`;
    if (entry.reason != null) line += `  reason: ${yq(entry.reason)}\n`;
    if (Array.isArray(entry.alternatives_considered) && entry.alternatives_considered.length) {
      line += `  alternatives_considered:\n`;
      for (const a of entry.alternatives_considered) line += `    - ${yq(a)}\n`;
    }
    fs.appendFileSync(auditFile, line);
    return true;
  } catch {
    return false;
  }
}

function parseArgs() {
  const a = process.argv.slice(2);
  const p = {};
  for (let i = 0; i < a.length; i++) {
    switch (a[i]) {
      case "--workspace": p.workspace = a[++i]; break;
      case "--tier": p.tier = a[++i]; break;
      case "--decision": p.decision = a[++i]; break;
      case "--signal": p.signal = a[++i]; break;
      case "--rationale": p.rationale = a[++i]; break;
    }
  }
  return p;
}

module.exports = { appendDecision };

if (require.main === module) {
  const p = parseArgs();
  if (!p.workspace || !p.decision) {
    console.log("err:usage: node audit-log.js --workspace <ws> --decision <text> [--tier T] [--signal S] [--rationale R]");
    process.exit(1);
  }
  const ok = appendDecision(p.workspace, { tier: p.tier, decision: p.decision, triggering_signal: p.signal, rationale: p.rationale });
  console.log(ok ? "ok:audit appended" : "err:audit append failed");
}
