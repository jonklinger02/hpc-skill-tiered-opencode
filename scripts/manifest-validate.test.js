#!/usr/bin/env node
// Tests for manifest-validate.js — validation gates 1, 2, and 3.
// Uses node:test (built into Node ≥18) — no external deps.
//
// Run via:    node manifest-validate.test.js
// Or:        ./run-tests.sh

const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const VALIDATE_SCRIPT = path.resolve(__dirname, "manifest-validate.js");

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Create a temp directory populated with the given file map.
 * Keys are relative paths from the temp root; values are file contents.
 * Returns the absolute path to the temp root.
 */
function makeTempManifest(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hpc-validate-test-"));
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run manifest-validate.js and return its stdout (trimmed).
 * Never throws — on non-zero exit we still return stdout.
 */
function runGate(gate, manifestDir, extra = "") {
  try {
    return execSync(
      `node "${VALIDATE_SCRIPT}" --gate ${gate} --manifest-dir "${manifestDir}" ${extra}`,
      { encoding: "utf-8" }
    ).trim();
  } catch (e) {
    return ((e.stdout || "") + (e.stderr || "")).trim();
  }
}

// ── Fixture strings ───────────────────────────────────────────────────────

const VALID_EPIC = `\
epic_id: EPIC-001
name: User Authentication
acceptance_criteria:
  - Users can register with email and password
  - Users can log in and receive a session token
  - Invalid credentials return a 401
functional_areas:
  - API
  - DB
prd_refs:
  - REQ-001
  - REQ-002
priority: high
depends_on: []`;

const VALID_CONTRACT = `\
contract_id: CONTRACT-API-001
domain: API
schema_version: "1.0"
description: User session token shape
surface:
  - kind: TYPE
    name: "SessionToken"
    fields: ["token: string", "expires_at: ISO8601"]
definition: |
  SessionToken { token: string; expires_at: ISO8601 }`;

const VALID_GROUP = `\
group_id: GRP-API-001
epic_id: EPIC-001
area: API
contracts_produced:
  - CONTRACT-API-001
contracts_consumed: []
depends_on: []`;

const VALID_TASK = `\
task_id: TASK-API-0001
group_id: GRP-API-001
file_path: src/api/auth.ts
contracts_produced:
  - contract_id: CONTRACT-API-001
    implements: ["SessionToken"]
contracts_consumed: []
depends_on: []`;

// ═══════════════════════════════════════════════════════════════════════════
// GATE 1
// ═══════════════════════════════════════════════════════════════════════════

test("Gate 1: valid epic passes", () => {
  const dir = makeTempManifest({ "epics/EPIC-001.yaml": VALID_EPIC });
  try {
    assert.equal(runGate(1, dir), "ok");
  } finally { rm(dir); }
});

test("Gate 1: no epic files → fail with clear message", () => {
  const dir = makeTempManifest({ "epics/.gitkeep": "" });
  try {
    const result = runGate(1, dir);
    assert.match(result, /err:/, "should report an error");
    assert.match(result, /epic/i, "error should mention epics");
  } finally { rm(dir); }
});

test("Gate 1: missing acceptance_criteria → fail naming the epic", () => {
  const content = `\
epic_id: EPIC-001
name: Auth
acceptance_criteria: []
functional_areas:
  - API
depends_on: []`;
  const dir = makeTempManifest({ "epics/EPIC-001.yaml": content });
  try {
    const result = runGate(1, dir);
    assert.match(result, /err:/);
    assert.match(result, /acceptance_criteria/);
    assert.match(result, /EPIC-001/);
  } finally { rm(dir); }
});

test("Gate 1: missing functional_areas → fail naming the epic", () => {
  const content = `\
epic_id: EPIC-001
name: Auth
acceptance_criteria:
  - Users can register
functional_areas: []
depends_on: []`;
  const dir = makeTempManifest({ "epics/EPIC-001.yaml": content });
  try {
    const result = runGate(1, dir);
    assert.match(result, /err:/);
    assert.match(result, /functional_areas/);
  } finally { rm(dir); }
});

test("Gate 1: multiple valid epics all pass", () => {
  const epic2 = `\
epic_id: EPIC-002
name: Data Model
acceptance_criteria:
  - Tables are created via migrations
functional_areas:
  - DB
depends_on:
  - EPIC-001`;
  const dir = makeTempManifest({
    "epics/EPIC-001.yaml": VALID_EPIC,
    "epics/EPIC-002.yaml": epic2,
  });
  try {
    assert.equal(runGate(1, dir), "ok");
  } finally { rm(dir); }
});

test("Gate 1: PRD requirement unmapped → fail naming the requirement", () => {
  const prd = "## Requirements\n\nREQ-001 Login flow\nREQ-002 Registration\nREQ-003 Password reset";
  const dir = makeTempManifest({
    "epics/EPIC-001.yaml": VALID_EPIC, // only covers REQ-001, REQ-002
    "prd.md": prd,
  });
  try {
    const prdPath = path.join(dir, "prd.md");
    const result = runGate(1, dir, `--prd "${prdPath}"`);
    assert.match(result, /err:/);
    assert.match(result, /REQ-003/);
  } finally { rm(dir); }
});

test("Gate 1: PRD with all requirements mapped → pass", () => {
  const epicWithAllRefs = VALID_EPIC.replace(
    "prd_refs:\n  - REQ-001\n  - REQ-002",
    "prd_refs:\n  - REQ-001\n  - REQ-002\n  - REQ-003"
  );
  const prd = "REQ-001 Login\nREQ-002 Register\nREQ-003 Reset";
  const dir = makeTempManifest({
    "epics/EPIC-001.yaml": epicWithAllRefs,
    "prd.md": prd,
  });
  try {
    const prdPath = path.join(dir, "prd.md");
    assert.equal(runGate(1, dir, `--prd "${prdPath}"`), "ok");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// GATE 2
// ═══════════════════════════════════════════════════════════════════════════

test("Gate 2: valid task group + contract → passes", () => {
  const dir = makeTempManifest({
    "task-groups/GRP-API-001.yaml": VALID_GROUP,
    "contracts/CONTRACT-API-001.yaml": VALID_CONTRACT,
  });
  try {
    assert.equal(runGate(2, dir), "ok");
  } finally { rm(dir); }
});

test("Gate 2: no task group files → fail", () => {
  const dir = makeTempManifest({
    "contracts/CONTRACT-API-001.yaml": VALID_CONTRACT,
  });
  try {
    const result = runGate(2, dir);
    assert.match(result, /err:/);
    assert.match(result, /task group/i);
  } finally { rm(dir); }
});

test("Gate 2: contract reference missing from contracts dir → fail naming it", () => {
  const groupBadRef = `\
group_id: GRP-API-001
epic_id: EPIC-001
area: API
contracts_produced:
  - CONTRACT-MISSING-999
contracts_consumed: []
depends_on: []`;
  const dir = makeTempManifest({
    "task-groups/GRP-API-001.yaml": groupBadRef,
    "contracts/CONTRACT-API-001.yaml": VALID_CONTRACT,
  });
  try {
    const result = runGate(2, dir);
    assert.match(result, /err:/);
    assert.match(result, /CONTRACT-MISSING-999/);
  } finally { rm(dir); }
});

test("Gate 2: consumed contract missing from contracts dir → fail", () => {
  const groupConsumesMissing = `\
group_id: GRP-DB-001
epic_id: EPIC-001
area: DB
contracts_produced: []
contracts_consumed:
  - CONTRACT-MISSING-001
depends_on: []`;
  const dir = makeTempManifest({
    "task-groups/GRP-DB-001.yaml": groupConsumesMissing,
    "contracts/CONTRACT-API-001.yaml": VALID_CONTRACT,
  });
  try {
    const result = runGate(2, dir);
    assert.match(result, /err:/);
    assert.match(result, /CONTRACT-MISSING-001/);
  } finally { rm(dir); }
});

test("Gate 2: namespace collision in ownership.yaml → fail", () => {
  const ownership = `\
namespaces:
  - path_pattern: "src/api/**"
    owning_area: "API"
  - path_pattern: "src/api/**"
    owning_area: "DB"`;
  const dir = makeTempManifest({
    "task-groups/GRP-API-001.yaml": VALID_GROUP,
    "contracts/CONTRACT-API-001.yaml": VALID_CONTRACT,
    "ownership.yaml": ownership,
  });
  try {
    const result = runGate(2, dir);
    assert.match(result, /err:/);
    assert.match(result, /src\/api/);
  } finally { rm(dir); }
});

test("Gate 2: unique ownership in ownership.yaml → pass", () => {
  const ownership = `\
namespaces:
  - path_pattern: "src/api/**"
    owning_area: "API"
  - path_pattern: "src/db/**"
    owning_area: "DB"`;
  const dir = makeTempManifest({
    "task-groups/GRP-API-001.yaml": VALID_GROUP,
    "contracts/CONTRACT-API-001.yaml": VALID_CONTRACT,
    "ownership.yaml": ownership,
  });
  try {
    assert.equal(runGate(2, dir), "ok");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// GATE 3
// ═══════════════════════════════════════════════════════════════════════════

test("Gate 3: valid task + contract → passes", () => {
  const dir = makeTempManifest({
    "tasks/TASK-API-0001.yaml": VALID_TASK,
    "contracts/CONTRACT-API-001.yaml": VALID_CONTRACT,
  });
  try {
    assert.equal(runGate(3, dir), "ok");
  } finally { rm(dir); }
});

test("Gate 3: no atomic task files → fail", () => {
  const dir = makeTempManifest({
    "contracts/CONTRACT-API-001.yaml": VALID_CONTRACT,
  });
  try {
    const result = runGate(3, dir);
    assert.match(result, /err:/);
    assert.match(result, /task/i);
  } finally { rm(dir); }
});

test("Gate 3: two tasks writing the same file_path → fail with collision", () => {
  const task2 = `\
task_id: TASK-API-0002
group_id: GRP-API-001
file_path: src/api/auth.ts
contracts_produced: []
contracts_consumed: []
depends_on: []`;
  const dir = makeTempManifest({
    "tasks/TASK-API-0001.yaml": VALID_TASK,
    "tasks/TASK-API-0002.yaml": task2,
    "contracts/CONTRACT-API-001.yaml": VALID_CONTRACT,
  });
  try {
    const result = runGate(3, dir);
    assert.match(result, /err:/);
    assert.match(result, /collision/i);
    assert.match(result, /src\/api\/auth\.ts/);
  } finally { rm(dir); }
});

test("Gate 3: distinct file paths → no collision", () => {
  const task2 = `\
task_id: TASK-API-0002
group_id: GRP-API-001
file_path: src/api/users.ts
contracts_produced: []
contracts_consumed:
  - CONTRACT-API-001
depends_on: []`;
  const dir = makeTempManifest({
    "tasks/TASK-API-0001.yaml": VALID_TASK,
    "tasks/TASK-API-0002.yaml": task2,
    "contracts/CONTRACT-API-001.yaml": VALID_CONTRACT,
  });
  try {
    assert.equal(runGate(3, dir), "ok");
  } finally { rm(dir); }
});

test("Gate 3: task references non-existent contract → fail naming it", () => {
  const taskBadRef = `\
task_id: TASK-API-0001
group_id: GRP-API-001
file_path: src/api/auth.ts
contracts_produced:
  - CONTRACT-NONEXISTENT-007
contracts_consumed: []
depends_on: []`;
  const dir = makeTempManifest({
    "tasks/TASK-API-0001.yaml": taskBadRef,
    "contracts/CONTRACT-API-001.yaml": VALID_CONTRACT,
  });
  try {
    const result = runGate(3, dir);
    assert.match(result, /err:/);
    assert.match(result, /CONTRACT-NONEXISTENT-007/);
  } finally { rm(dir); }
});

test("Gate 1: inline quoted prd_refs array (spaces after commas) maps every requirement", () => {
  // Regression: extractArray must trim BEFORE stripping quotes, else every
  // element after the first in `["REQ-001", "REQ-002", ...]` keeps a leading
  // quote and silently fails PRD coverage. Surfaced by a live C-Suite output.
  const epic = `\
epic_id: EPIC-001
name: Auth
acceptance_criteria:
  - Users can log in
functional_areas:
  - API
prd_refs: ["REQ-001", "REQ-002", "REQ-003", "REQ-004"]
depends_on: []`;
  const prd = "REQ-001 a\nREQ-002 b\nREQ-003 c\nREQ-004 d";
  const dir = makeTempManifest({ "epics/EPIC-001.yaml": epic, "prd.md": prd });
  try {
    assert.equal(runGate(1, dir, `--prd "${path.join(dir, "prd.md")}"`), "ok");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// GATE 1 — M1 plan-completeness mode (--completeness)
// ═══════════════════════════════════════════════════════════════════════════

const GLUE_EPIC = `\
epic_id: E-GLUE-000
name: Glue and boot layer
acceptance_criteria:
  - Vite app builds and boots
functional_areas:
  - GLUE
depends_on: []`;

const MANIFEST_WEB_UI = `\
status: PLANNING
tech_stack:
  - language: typescript
    role: web_ui
    framework: react
    bundler: vite
    package_manager: npm`;

const DECISIONS_OK = `\
decisions_log:
  - decision: Defer multi-tenant org isolation
    status: deferred
    rationale: out of scope for MVP
    deferral_disposition:
      waiver: no current-build consumer
      countersigned_by: ["Synthesizer", "Critic"]`;

const DECISIONS_BAD = `\
decisions_log:
  - decision: Defer multi-tenant org isolation
    status: deferred
    rationale: out of scope for MVP`;

const ACCEPTANCE_OK = `\
acceptance_criteria:
  - id: AC-001
    source: REQ-AUTO-001
    text: The dashboard shows canary rollout percentage
    classification: observable
    judgeable_directly: true
    requires_subcriteria: false`;

// EPIC-001 (VALID_EPIC) functional_areas include API + DB, so "API" is a
// satisfiable current-build dependency.
const DEFERRED_OK = `\
deferred_scope:
  - id: DEFERRED-001
    corpus_sections:
      - "PRD section 9 multi-tenant"
    summary: |
      Neo4j capability graph storage for multi-org isolation.
    rationale: out of scope
    depends_on_current_build:
      - "API"
    suggested_future_epic: E-MULTI-TENANT
    rough_task_estimate: 40`;

// web_ui declares a runnable surface, so a complete autonomous-mode manifest
// must ship a build-commands.yaml with a boot_smoke command (M2 §2.1).
const BUILD_COMMANDS_OK = `\
typecheck: npx tsc --noEmit
build: npx vite build
boot_smoke: npx vite preview --port 5173`;

// Build a complete, passing completeness fixture, then let callers mutate it.
function completenessFixture(overrides = {}) {
  return Object.assign({
    "epics/EPIC-001.yaml": VALID_EPIC,
    "epics/E-GLUE-000.yaml": GLUE_EPIC,
    "manifest.yaml": MANIFEST_WEB_UI,
    "build-commands.yaml": BUILD_COMMANDS_OK,
    "deliberations/csuite-decisions-log.yaml": DECISIONS_OK,
    "acceptance-criteria.yaml": ACCEPTANCE_OK,
    "deferred-scope.yaml": DEFERRED_OK,
  }, overrides);
}

function runCompleteness(dir) {
  const ds = path.join(dir, "deferred-scope.yaml");
  return runGate(1, dir, `--completeness --deferred-scope "${ds}"`);
}

test("Gate 1 completeness: full valid completeness fixture → ok", () => {
  const dir = makeTempManifest(completenessFixture());
  try {
    assert.equal(runCompleteness(dir), "ok");
  } finally { rm(dir); }
});

test("Gate 1 completeness: opt-in only — same no-tech_stack fixture passes WITHOUT --completeness", () => {
  // Backward compat: without the flag, Gate 1 ignores tech_stack/glue/etc.
  const dir = makeTempManifest({ "epics/EPIC-001.yaml": VALID_EPIC });
  try {
    assert.equal(runGate(1, dir), "ok");                       // legacy path: ok
    assert.match(runGate(1, dir, "--completeness"), /err:/);   // strict path: fails (no tech_stack)
  } finally { rm(dir); }
});

test("Gate 1 completeness: missing tech_stack → fail", () => {
  const dir = makeTempManifest(completenessFixture({ "manifest.yaml": "status: PLANNING\n" }));
  try {
    const r = runCompleteness(dir);
    assert.match(r, /err:/);
    assert.match(r, /tech_stack/);
  } finally { rm(dir); }
});

test("Gate 1 completeness: web_ui stack but missing glue epic → fail", () => {
  const fx = completenessFixture();
  delete fx["epics/E-GLUE-000.yaml"];
  const dir = makeTempManifest(fx);
  try {
    const r = runCompleteness(dir);
    assert.match(r, /err:/);
    assert.match(r, /E-GLUE-000/);
  } finally { rm(dir); }
});

test("Gate 1 completeness: deferred decision without deferral_disposition → fail", () => {
  const dir = makeTempManifest(completenessFixture({ "deliberations/csuite-decisions-log.yaml": DECISIONS_BAD }));
  try {
    const r = runCompleteness(dir);
    assert.match(r, /err:/);
    assert.match(r, /deferral_disposition/);
  } finally { rm(dir); }
});

test("Gate 1 completeness: missing acceptance-criteria.yaml → fail", () => {
  const fx = completenessFixture();
  delete fx["acceptance-criteria.yaml"];
  const dir = makeTempManifest(fx);
  try {
    const r = runCompleteness(dir);
    assert.match(r, /err:/);
    assert.match(r, /acceptance-criteria/);
  } finally { rm(dir); }
});

test("Gate 1 completeness: deferred-scope dependency not in any epic output → fail", () => {
  const badDeferred = DEFERRED_OK.replace('- "API"', '- "Quantum teleportation service"');
  const dir = makeTempManifest(completenessFixture({ "deferred-scope.yaml": badDeferred }));
  try {
    const r = runCompleteness(dir);
    assert.match(r, /err:/);
    assert.match(r, /depends_on_current_build/);
  } finally { rm(dir); }
});

// ── M2 §2.1: boot_smoke requirement (completeness Gate 1) ──
test("Gate 1 completeness: runnable stack but no boot_smoke command → fail", () => {
  const fx = completenessFixture();
  delete fx["build-commands.yaml"];
  const dir = makeTempManifest(fx);
  try {
    const r = runCompleteness(dir);
    assert.match(r, /err:/);
    assert.match(r, /boot_smoke/);
  } finally { rm(dir); }
});

// ── M2 §2.5: coverage_gap / --strict-coverage (Gate 3) ──
test("Gate 3 strict-coverage: empty contracts_produced in a multi-file module → fail", () => {
  // Two tasks write into the SAME directory (a multi-file module); one declares
  // no contracts_produced.
  const producer = `\
task_id: TASK-API-0001
group_id: GRP-API-001
file_path: src/api/auth.ts
contracts_produced:
  - contract_id: CONTRACT-API-001
    implements: ["SessionToken"]
contracts_consumed: []
depends_on: []`;
  const uncovered = `\
task_id: TASK-API-0002
group_id: GRP-API-001
file_path: src/api/helpers.ts
contracts_produced: []
contracts_consumed: []
depends_on: []`;
  const dir = makeTempManifest({
    "tasks/TASK-API-0001.yaml": producer,
    "tasks/TASK-API-0002.yaml": uncovered,
    "contracts/CONTRACT-API-001.yaml": VALID_CONTRACT,
  });
  try {
    // Default (no flag): coverage_gap is advisory, gate passes.
    assert.equal(runGate(3, dir), "ok");
    // Strict: the uncovered task in the multi-file module blocks.
    const r = runGate(3, dir, "--strict-coverage");
    assert.match(r, /err:/);
    assert.match(r, /TASK-API-0002/);
    assert.match(r, /multi-file module/);
  } finally { rm(dir); }
});

test("Gate 3: consumed-only contract is not a hard failure (orphan advisory)", () => {
  // A contract that is consumed but never produced emits a warning, not a gate failure.
  // This is documented in manifest-validate.js: orphan-contract checks are advisories.
  // Uses a surfaceless (legacy/advisory) contract so the binding surface-coverage check
  // does not apply — this test exercises the orphan-advisory path specifically.
  const legacyContract = `\
contract_id: CONTRACT-LEGACY-001
domain: API
schema_version: "1.0"
description: Legacy advisory contract (no binding surface)`;
  const taskConsumer = `\
task_id: TASK-API-0001
group_id: GRP-API-001
file_path: src/api/auth.ts
contracts_produced: []
contracts_consumed:
  - CONTRACT-LEGACY-001
depends_on: []`;
  const dir = makeTempManifest({
    "tasks/TASK-API-0001.yaml": taskConsumer,
    "contracts/CONTRACT-LEGACY-001.yaml": legacyContract,
  });
  try {
    // Should still pass the gate even if contracts are orphaned (advisory only)
    const result = runGate(3, dir);
    assert.equal(result, "ok", "orphan advisory should not block gate 3");
  } finally { rm(dir); }
});

test("Gate 3: MODULE-PATHS-MANIFEST is a virtual contract — consumed without a producer is OK", () => {
  const task = `\
task_id: TASK-UI-0001
group_id: GRP-UI-001
file_path: src/ui/components/Button.tsx
contracts_produced: []
contracts_consumed:
  - contract_id: MODULE-PATHS-MANIFEST
    invokes: ["alias_anchors"]
depends_on: []`;
  const dir = makeTempManifest({ "tasks/TASK-UI-0001.yaml": task });
  try {
    assert.equal(runGate(3, dir), "ok", "virtual MODULE-PATHS-MANIFEST must not fail Gate 3");
  } finally { rm(dir); }
});

// ── Gate 4: framework-standard layout ───────────────────────────────────────

test.test("Gate 4: nextjs-app flags a pages-router route as a layout violation", () => {
  const dir = makeTempManifest({
    "manifest.yaml": "tech_stack:\n  - {language: typescript, role: ssr_app, framework: nextjs}\n",
    "tasks/T1.yaml": 'task_id: "TASK-1"\nfile_path: "app/dashboard/page.tsx"\n',
    "tasks/T2.yaml": 'task_id: "TASK-2"\nfile_path: "pages/legacy.tsx"\n',
  });
  try {
    const out = runGate(4, dir);
    assert.match(out, /err:gate_4_failures/);
    assert.match(out, /TASK-2/);
    assert.match(out, /must live under 'app\//);
  } finally { rm(dir); }
});

test.test("Gate 4: passes when every file_path conforms to the profile", () => {
  const dir = makeTempManifest({
    "manifest.yaml": "tech_stack:\n  - {language: typescript, role: api_server, framework: express}\n",
    "tasks/T1.yaml": 'task_id: "TASK-1"\nfile_path: "src/routes/users.ts"\n',
    "tasks/T2.yaml": 'task_id: "TASK-2"\nfile_path: "src/controllers/userController.ts"\n',
  });
  try {
    assert.equal(runGate(4, dir), "ok");
  } finally { rm(dir); }
});

test.test("Gate 4: unknown stack resolves to generic and enforces nothing", () => {
  const dir = makeTempManifest({
    "manifest.yaml": "tech_stack:\n  - {language: cobol}\n",
    "tasks/T1.yaml": 'task_id: "TASK-1"\nfile_path: "wherever/it.cbl"\n',
  });
  try {
    assert.equal(runGate(4, dir), "ok");
  } finally { rm(dir); }
});
