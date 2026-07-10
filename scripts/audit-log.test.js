#!/usr/bin/env node
// Tests for audit-log.js — the autonomous-decision audit trail appender.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");
const { execSync } = require("child_process");
const { appendDecision } = require("./audit-log.js");

function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "hpc-audit-test-")); }
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const SCRIPT = path.resolve(__dirname, "audit-log.js");

test("appendDecision: writes a parseable YAML list item with all fields", () => {
  const dir = mkTmp();
  try {
    appendDecision(dir, {
      tier: "M5_TIER_3",
      decision: "Forked workspace to hpc-workspace.tier3-iteration-1",
      triggering_signal: "Tier 2 exhausted 3 iterations on slice S-abc",
      rationale: "Slice spans 3 epics; Tier 3 is the correct tier",
      alternatives_considered: ["Continue Tier 2", "Escalate to Tier 4 directly"],
    });
    const f = path.join(dir, "wiki", "autonomous-decisions.yaml");
    assert.ok(fs.existsSync(f));
    const doc = yaml.load(fs.readFileSync(f, "utf-8"));
    assert.ok(Array.isArray(doc) && doc.length === 1);
    assert.equal(doc[0].tier, "M5_TIER_3");
    assert.match(doc[0].decision, /Forked workspace/);
    assert.equal(doc[0].alternatives_considered.length, 2);
    assert.ok(doc[0].timestamp);
  } finally { rm(dir); }
});

test("appendDecision: multiple appends accumulate into a valid YAML list", () => {
  const dir = mkTmp();
  try {
    appendDecision(dir, { tier: "M5_RECOVERY", decision: "Recovery triggered", triggering_signal: "blocked_forks" });
    appendDecision(dir, { tier: "M5_TIER_4", decision: "Emitted SPEC-DEFECT.md" });
    const doc = yaml.load(fs.readFileSync(path.join(dir, "wiki", "autonomous-decisions.yaml"), "utf-8"));
    assert.equal(doc.length, 2);
    assert.equal(doc[1].decision, "Emitted SPEC-DEFECT.md");
  } finally { rm(dir); }
});

test("appendDecision: text with quotes/newlines stays valid YAML", () => {
  const dir = mkTmp();
  try {
    appendDecision(dir, { decision: 'amendment touched 7/10 tasks (70%)\nexceeds "60%" threshold' });
    const doc = yaml.load(fs.readFileSync(path.join(dir, "wiki", "autonomous-decisions.yaml"), "utf-8"));
    assert.match(doc[0].decision, /70%/);
  } finally { rm(dir); }
});

test("CLI: appends and reports ok; missing args → err", () => {
  const dir = mkTmp();
  try {
    const out = execSync(`node "${SCRIPT}" --workspace "${dir}" --tier M5_TIER_3 --decision "test" --signal sig`, { encoding: "utf-8" }).trim();
    assert.match(out, /^ok:/);
    const doc = yaml.load(fs.readFileSync(path.join(dir, "wiki", "autonomous-decisions.yaml"), "utf-8"));
    assert.equal(doc[0].triggering_signal, "sig");
    let err;
    try { execSync(`node "${SCRIPT}" --tier X`, { encoding: "utf-8" }); }
    catch (e) { err = ((e.stdout || "") + (e.stderr || "")).trim(); }
    assert.match(err, /err:/);
  } finally { rm(dir); }
});
