#!/usr/bin/env node
// Tests for subagent.js worker-output sanitization and language detection.
// Uses node:test (built into Node ≥18) — no external deps.
//
// Run via:    node subagent.test.js
// Or:        ./run-tests.sh

const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanWorkerOutput, commentPrefixFor } = require("./subagent");

// ── commentPrefixFor ──────────────────────────────────────────────────────

test("commentPrefixFor: python → #", () => {
  assert.equal(commentPrefixFor("foo/bar.py"), "#");
});

test("commentPrefixFor: rust → //", () => {
  assert.equal(commentPrefixFor("traversal/keyword_index.rs"), "//");
});

test("commentPrefixFor: typescript and tsx → //", () => {
  assert.equal(commentPrefixFor("frontend/state.ts"), "//");
  assert.equal(commentPrefixFor("frontend/state.tsx"), "//");
});

test("commentPrefixFor: sql → --", () => {
  assert.equal(commentPrefixFor("migrations/001.sql"), "--");
});

test("commentPrefixFor: yaml → #", () => {
  assert.equal(commentPrefixFor("infra/compose.yaml"), "#");
  assert.equal(commentPrefixFor("infra/compose.yml"), "#");
});

test("commentPrefixFor: shell → #", () => {
  assert.equal(commentPrefixFor("bin/build.sh"), "#");
  assert.equal(commentPrefixFor("bin/run.bash"), "#");
});

test("commentPrefixFor: extensionless Dockerfile/Makefile → #", () => {
  assert.equal(commentPrefixFor("infra/Dockerfile"), "#");
  assert.equal(commentPrefixFor("Makefile"), "#");
});

test("commentPrefixFor: null/undefined → # (default)", () => {
  assert.equal(commentPrefixFor(null), "#");
  assert.equal(commentPrefixFor(undefined), "#");
});

test("commentPrefixFor: case-insensitive on extension", () => {
  assert.equal(commentPrefixFor("foo/Bar.PY"), "#");
  assert.equal(commentPrefixFor("foo/Bar.RS"), "//");
});

// ── cleanWorkerOutput ─────────────────────────────────────────────────────

test("cleanWorkerOutput: plain code passes through unchanged (modulo trailing newline)", () => {
  const src = "import sys\n\ndef main():\n    return 0";
  assert.equal(cleanWorkerOutput(src), "import sys\n\ndef main():\n    return 0\n");
});

test("cleanWorkerOutput: empty/null is returned as-is", () => {
  assert.equal(cleanWorkerOutput(""), "");
  assert.equal(cleanWorkerOutput(null), null);
  assert.equal(cleanWorkerOutput(undefined), undefined);
});

test("cleanWorkerOutput: strips simple ```python wrapper", () => {
  const src = "```python\nimport sys\n\ndef main():\n    pass\n```";
  const out = cleanWorkerOutput(src);
  assert.equal(out, "import sys\n\ndef main():\n    pass\n");
});

test("cleanWorkerOutput: strips ``` (no language tag) wrapper", () => {
  const src = "```\nimport sys\n```";
  assert.equal(cleanWorkerOutput(src), "import sys\n");
});

test("cleanWorkerOutput: takes the largest of multiple fenced blocks", () => {
  const src = "```python\nshort\n```\n\nsome prose\n\n```python\nimport sys\nimport os\nimport json\nimport re\n```";
  const out = cleanWorkerOutput(src);
  assert.match(out, /import sys/);
  assert.match(out, /import os/);
  assert.doesNotMatch(out, /^short$/m);
});

test("cleanWorkerOutput: drops leading 'I will…' prose before fenced block", () => {
  const src = "I will implement this directly.\n\nHere is the code:\n\n```python\nimport sys\n```";
  const out = cleanWorkerOutput(src);
  assert.equal(out, "import sys\n");
});

test("cleanWorkerOutput: drops leading prose when no fences present", () => {
  const src = "I cannot use external tools. Let me provide it directly:\n\n# SYNOPSIS\nimport sys";
  const out = cleanWorkerOutput(src);
  assert.match(out, /^# SYNOPSIS/);
  assert.doesNotMatch(out, /I cannot/);
});

test("cleanWorkerOutput: strips leaked metadata frontmatter (contains task_id)", () => {
  const src = "---\ntask_id: OB-T-014\nfile_path: foo.py\n---\nimport sys\n";
  const out = cleanWorkerOutput(src);
  assert.equal(out, "import sys\n");
});

test("cleanWorkerOutput: preserves legitimate YAML doc separator (no task_id)", () => {
  // Legit YAML doc-start `---` should NOT be stripped — only metadata blocks.
  const src = "---\nservices:\n  api:\n    image: foo\n---\nother: doc\n";
  const out = cleanWorkerOutput(src);
  assert.match(out, /^---/);
  assert.match(out, /services:/);
});

test("cleanWorkerOutput: removes stray fence-only lines without proper block", () => {
  const src = "```\nimport sys\n\ndef main():\n    pass";
  const out = cleanWorkerOutput(src);
  assert.doesNotMatch(out, /```/);
  assert.match(out, /import sys/);
});

test("cleanWorkerOutput: strips BOM", () => {
  const src = "﻿import sys\n";
  const out = cleanWorkerOutput(src);
  assert.equal(out.charCodeAt(0), "i".charCodeAt(0));
});

test("cleanWorkerOutput: preserves SQL keyword as code-start", () => {
  const src = "Here is the migration:\n\nCREATE TABLE foo (\n  id UUID PRIMARY KEY\n);";
  const out = cleanWorkerOutput(src);
  assert.match(out, /^CREATE TABLE/);
});

test("cleanWorkerOutput: preserves YAML key as code-start", () => {
  const src = "Configuration:\n\nservices:\n  api:\n    image: foo";
  const out = cleanWorkerOutput(src);
  assert.match(out, /^services:/);
});

test("cleanWorkerOutput: TS // comment is a valid code-start (not stripped as prose)", () => {
  const src = "// SYNOPSIS\n// L1-L5: imports\n\nimport React from 'react';";
  const out = cleanWorkerOutput(src);
  assert.match(out, /^\/\/ SYNOPSIS/);
});

test("cleanWorkerOutput: real-world haiku-style fenced output unwraps cleanly", () => {
  const src = [
    "I'll generate the implementation directly.",
    "",
    "```python",
    "# SYNOPSIS",
    "# L1-L5: imports",
    "# L7-L20: main",
    "",
    "import asyncio",
    "from typing import List",
    "",
    "async def submit(items: List[str]) -> None:",
    "    pass",
    "```",
  ].join("\n");
  const out = cleanWorkerOutput(src);
  assert.match(out, /^# SYNOPSIS/);
  assert.match(out, /async def submit/);
  assert.doesNotMatch(out, /```/);
  assert.doesNotMatch(out, /I'll generate/);
});

test("cleanWorkerOutput: trims trailing whitespace and ensures single trailing newline", () => {
  const src = "import sys\n\n\n\n";
  const out = cleanWorkerOutput(src);
  assert.equal(out, "import sys\n");
});

// ── M3.5 §3.5.4: per-task deliverables checklist injection ──
const os2 = require("os");
const fs = require("fs");
const path = require("path");
test("buildDeliverablesChecklist: lists implements + invokes from task contracts", () => {
  const { buildDeliverablesChecklist } = require("./subagent.js");
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "hpc-sa-test-"));
  const tf = path.join(dir, "TASK-API-0001.yaml");
  fs.writeFileSync(tf, `task_id: TASK-API-0001
file_path: src/api/auth.ts
contracts_produced:
  - contract_id: CONTRACT-API-001
    implements: ["SessionToken", "createSession"]
contracts_consumed:
  - contract_id: CONTRACT-DB-001
    invokes: ["UserStore.get"]
`);
  try {
    const out = buildDeliverablesChecklist(tf);
    assert.match(out, /DELIVERABLES FOR THIS TASK/);
    assert.match(out, /DEFINE.*SessionToken/);
    assert.match(out, /DEFINE.*createSession/);
    assert.match(out, /CALL.*UserStore\.get/);
    assert.match(out, /CONTRACT-API-001/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("buildDeliverablesChecklist: empty for a task with no structured contracts", () => {
  const { buildDeliverablesChecklist } = require("./subagent.js");
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "hpc-sa-test-"));
  const tf = path.join(dir, "TASK-X.yaml");
  fs.writeFileSync(tf, "task_id: TASK-X\nfile_path: src/x.ts\ncontracts_produced: []\ncontracts_consumed: []\n");
  try {
    assert.equal(buildDeliverablesChecklist(tf), "");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Test-writer ↔ surface binding ──
function writeContract(dir, id, body) {
  fs.writeFileSync(path.join(dir, `${id}.yaml`), body);
}

test("buildSurfaceBindingBlock: TEST task gets exact consumed-contract signatures + surface-wins clause", () => {
  const { buildSurfaceBindingBlock } = require("./subagent.js");
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "hpc-sb-test-"));
  const cdir = path.join(dir, "contracts");
  fs.mkdirSync(cdir);
  writeContract(cdir, "CONTRACT-API-001", `contract_id: CONTRACT-API-001
surface:
  - kind: METHOD
    name: createFacebookLoginRouter
    signature: "createFacebookLoginRouter(context: PluginContext) -> Router"
    async: false
`);
  const tf = path.join(dir, "TASK-API-0006.yaml");
  fs.writeFileSync(tf, `task_id: TASK-API-0006
file_path: src/server/plugins/facebook-login/__tests__/router.test.ts
artifact_type: TEST
contracts_consumed:
  - contract_id: CONTRACT-API-001
    invokes: ["createFacebookLoginRouter"]
`);
  try {
    const out = buildSurfaceBindingBlock(tf, cdir);
    assert.match(out, /SURFACE BINDING/);
    assert.match(out, /createFacebookLoginRouter\(context: PluginContext\) -> Router/);
    assert.match(out, /CONTRACT-API-001/);
    assert.match(out, /SURFACE WINS/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("buildSurfaceBindingBlock: non-TEST task returns empty (non-test prompts unchanged)", () => {
  const { buildSurfaceBindingBlock } = require("./subagent.js");
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "hpc-sb-test-"));
  const cdir = path.join(dir, "contracts");
  fs.mkdirSync(cdir);
  writeContract(cdir, "CONTRACT-API-001", `contract_id: CONTRACT-API-001
surface:
  - { kind: METHOD, name: foo, signature: "foo() -> void" }
`);
  const tf = path.join(dir, "TASK-API-0001.yaml");
  fs.writeFileSync(tf, `task_id: TASK-API-0001
file_path: src/server/router.ts
artifact_type: IMPLEMENTATION
contracts_consumed:
  - contract_id: CONTRACT-API-001
    invokes: ["foo"]
`);
  try {
    assert.equal(buildSurfaceBindingBlock(tf, cdir), "");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("buildSurfaceBindingBlock: detects test by __tests__ path even without artifact_type", () => {
  const { buildSurfaceBindingBlock, isTestArtifact } = require("./subagent.js");
  assert.equal(isTestArtifact({}, "src/ui/__tests__/Foo.test.tsx"), true);
  assert.equal(isTestArtifact({}, "src/ui/Foo.tsx"), false);
  assert.equal(isTestArtifact({ artifact_type: "TEST" }, "src/x.ts"), true);
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "hpc-sb-test-"));
  const cdir = path.join(dir, "contracts");
  fs.mkdirSync(cdir);
  writeContract(cdir, "CONTRACT-UI-001", `contract_id: CONTRACT-UI-001
surface:
  - { kind: TYPE, name: FacebookLoginConfigInput, signature: "FacebookLoginConfigInput" }
`);
  const tf = path.join(dir, "TASK-UI-9.yaml");
  fs.writeFileSync(tf, `task_id: TASK-UI-9
file_path: src/ui/components/__tests__/AdminConfigPanel.test.tsx
contracts_consumed:
  - contract_id: CONTRACT-UI-001
    invokes: ["FacebookLoginConfigInput"]
`);
  try {
    const out = buildSurfaceBindingBlock(tf, cdir);
    assert.match(out, /FacebookLoginConfigInput/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── M3 §3.2: crash classification ──
test("classifyCrash: classifies common crash signatures", () => {
  const { classifyCrash } = require("./subagent.js");
  assert.equal(classifyCrash("", "", null, true), "timeout");
  assert.equal(classifyCrash("", "JavaScript heap out of memory", 1, false), "oom");
  assert.equal(classifyCrash("", "Error 429 rate limit exceeded", 1, false), "rate_limit");
  assert.equal(classifyCrash("", "", 1, false), "empty_output");
  assert.equal(classifyCrash("some output", "traceback ...", 1, false), "structured_error");
});

// ── ID-minting wiring: Director/Engineer council prompts must instruct mint-id ──
test("buildCouncilPrompt: director/engineer prompts inject the mint-id instruction; csuite does not", () => {
  const { buildCouncilPrompt } = require("./subagent.js");
  const dir = buildCouncilPrompt("director", "API", "/ws/manifest");
  assert.match(dir, /ID MINTING/);
  assert.match(dir, /mint-id\.js --manifest-dir \/ws\/manifest --type task_group --area/);
  assert.match(dir, /DO NOT INVENT IDs/);
  const eng = buildCouncilPrompt("engineer", "API", "/ws/manifest");
  assert.match(eng, /--type task\b/);  // engineer also mints task ids
  const cs = buildCouncilPrompt("csuite", null, "/ws/manifest");
  assert.doesNotMatch(cs, /ID MINTING/); // C-Suite emits epics; not wired to the minter
});

test("buildCouncilPrompt: engineer prompt is manifest-aware (reads surfaces, binds to existing)", () => {
  const { buildCouncilPrompt } = require("./subagent.js");
  const eng = buildCouncilPrompt("engineer", "API", "/ws/manifest");
  assert.match(eng, /MANIFEST AWARENESS/);
  assert.match(eng, /manifest-cli\.js --manifest-dir \/ws\/manifest surfaces/);
  assert.match(eng, /list --type task/);                 // reads existing file_paths
  assert.match(eng, /EXACT entry in some existing contract's surface/);
  const dir = buildCouncilPrompt("director", "API", "/ws/manifest");
  assert.match(dir, /MANIFEST AWARENESS/);               // directors read too (reuse, not duplicate)
});

test("buildImportBindingBlock: maps a consumed symbol to its producer file via module-paths", () => {
  const { buildImportBindingBlock } = require("./subagent.js");
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "hpc-imp-test-"));
  try {
    const mp = path.join(dir, "module-paths.yaml");
    fs.writeFileSync(mp, "module_paths:\n  symbol_to_path:\n    \"PaperclipUsers\": \"src/infra/adapters/users.adapter.ts\"\n    \"PaperclipUsers.findByEmail\": \"src/infra/adapters/users.adapter.ts\"\n  logical_name_to_path: {}\n");
    const tf = path.join(dir, "TASK-LIB-0001.yaml");
    fs.writeFileSync(tf, "task_id: TASK-LIB-0001\nfile_path: src/lib/account-resolver.ts\ncontracts_consumed:\n  - contract_id: CONTRACT-INFRA-001\n    invokes: [\"PaperclipUsers.findByEmail\"]\n");
    const out = buildImportBindingBlock(tf, mp);
    assert.match(out, /MODULE PATHS/);
    assert.match(out, /PaperclipUsers\.findByEmail/);
    assert.match(out, /src\/infra\/adapters\/users\.adapter\.ts/);   // exact producer file, not a guess
    assert.match(out, /account-resolver\.ts/);                       // tells the worker its own path
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
