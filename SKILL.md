---
name: hpc-tiered-opencode
description: "Hierarchical Planning Compiler (OpenCode-native tiered variant) — manifest-driven product build that routes tasks across cheap/capable/frontier models via models.yaml, running all sub-agents through `opencode serve` instead of the claude CLI. Multi-model councils split Claude (proposers) and GPT-5.5 (Critic+Synthesizer+reviewer). Use when asked for 'hpc-tiered-opencode', 'opencode hpc build', or when running inside OpenCode and wanting cost-optimized multi-model HPC. For the Claude Code variant use `hpc-tiered`; for a plain build with no model-tiering use `hpc`. Do NOT use for simple code snippets, single-file tasks, or questions about how HPC works — only for full product builds."
---

# Hierarchical Planning Compiler (HPC)

Build complete products from requirements — all the way to a running, tested, viewable application. HPC compiles a fully-resolved manifest before writing a single line of code, executes every task in parallel via sub-agents, then drives the built output through infrastructure emulation, application startup, E2E testing, and visual validation.

## Core Principle

Every sub-agent reports back **`ok`** or **`err:[description]`**. Sub-agents write outputs to disk. The orchestrator (you) never ingests full sub-agent output into context — only the status line. This keeps your context lean across the entire build.

## Prerequisites

Before starting, verify model access and required tooling:
```bash
# OpenCode harness — sub-agents run via opencode serve, not the claude CLI.
opencode --version   # must print a version; install via bun/npm if missing
node --version
npx playwright --version 2>/dev/null || echo "playwright not installed"
which docker 2>/dev/null || echo "docker not installed (needed for Postgres/Redis emulation)"
which firebase 2>/dev/null || echo "firebase-tools not installed (needed for Firebase projects)"
```

Install any missing tools:
```bash
npm install -g playwright && npx playwright install chromium
npm install -g firebase-tools        # if project uses Firebase
mkdir -p ./hpc-workspace && cd ./hpc-workspace && npm init -y && npm install
```

If `opencode --version` fails, install opencode: `bun install -g opencode-ai` or `npm install -g opencode-ai`.

### Live dashboard (start at skill startup — non-blocking)

As soon as the workspace exists, launch the build dashboard **in the background** so an operator can watch
progress live. It must NOT block the build — detach it and continue immediately:

```bash
nohup node scripts/dashboard.js --workspace ./hpc-workspace --port 3030 > ./hpc-workspace/dashboard.log 2>&1 &
echo $! > ./hpc-workspace/dashboard.pid    # for clean shutdown in Step 22
disown
# dashboard now serving at http://localhost:3030/ (binds 127.0.0.1 — local only).
# To watch from another machine, add `--host 0.0.0.0` only on a network you trust (no auth).
```

```bash
# Launch isolated opencode serve for HPC sub-agent calls (no plugins, no omo hooks).
mkdir -p ./hpc-workspace/opencode-config
cat > ./hpc-workspace/opencode-config/opencode.json <<'EOF'
{ "$schema": "https://opencode.ai/config.json", "plugin": [] }
EOF

OPENCODE_CONFIG_DIR="$PWD/hpc-workspace/opencode-config" \
OPENCODE_CONFIG="$PWD/hpc-workspace/opencode-config/opencode.json" \
OPENCODE_PURE=1 \
OPENCODE_DISABLE_EXTERNAL_SKILLS=1 \
OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1 \
opencode serve --port 4096 > ./hpc-workspace/opencode-serve.log 2>&1 &
echo $! > ./hpc-workspace/opencode-serve.pid
disown
export OPENCODE_SERVE_URL=http://127.0.0.1:4096
# Server CWD becomes the project root for tool-bearing agents — launch from the
# project output directory if workers need to read/write real files.
```

Pick another `--port` if 3030 is taken. The dashboard is read-only observability; it tolerates a
not-yet-initialized store (it renders empty state until Phase 2 creates `store/state.json`). Never
foreground it or `wait` on it — the build proceeds while it runs, and it is killed at shutdown
(Step 22) along with the app/emulators.

## Model Tiers

Model selection is driven by a central registry — `models.yaml` at the skill root — not by literal model
ids in commands. Four tiers map work to model power/cost:

- **cheap** (Haiku) — high-volume mechanical work with a tight spec and a deterministic check downstream
  (parallel workers, per-file schema validation, patch application).
- **standard** (Sonnet) — the workhorse: most councils, triage, integration/contract validation, document
  and test generation.
- **capable** (Opus) — hard cross-cutting judgment where a wrong call is expensive to unwind: escalations,
  the second e2e-repair tier, top-tier recovery.
- **frontier** (Fable) — the few highest-leverage correctness gates: the C-Suite plan the whole build
  inherits, and the acceptance verdict that decides ship / no-ship.

**Every model flag** (`--model`, `--worker-model`, `--validator-model`, `--judge-model`, `--triage-model`,
`--patch-model`, …) accepts a **tier name** (`cheap`/`standard`/`capable`/`frontier`), a **role name**
(`worker`, `csuite_council`, `acceptance_judge`, …), OR a **literal `claude-…` id** (passed through
unchanged for back-compat). Roles and literals both resolve via `scripts/lib/models.js`.

**`models.yaml` is the single place to re-point models.** Change a tier's id, or move a role to a different
tier, and every step that uses it follows automatically — no edits to SKILL.md or any script. For example:

```yaml
tiers:
  frontier: { providerID: anthropic, modelID: claude-opus-4-8 }  # example override
assignments:
  engineer_council: capable  # example: promote for a hard cross-cutting build
```

| Role | Tier | What it does |
|---|---|---|
| `worker` / `worker_promoted` / `worker_escalated` | cheap → standard → capable | parallel code workers (promotion ladder) |
| `schema_validator` | cheap | per-file local symbol/shape check |
| `integration_validator` | standard | deep producer/consumer contract validation |
| `triage` / `patch` | standard / cheap | Phase-3 failure verdict / quick_fix application |
| `engineer_council` / `director_council` | standard | task & contract planning councils |
| `csuite_council` | frontier | the plan every later tier is bound by |
| `escalation` | capable | resolve a worker's ambiguity envelope |
| `corpus_filter` / `acceptance_extract` | standard | corpus classification / acceptance-criteria prep |
| `e2e_generate` | standard | Playwright suite generation |
| `e2e_chase_tier1` / `e2e_chase_tier2` | standard / capable | E2E failure-chase repair tiers |
| `acceptance_judge` | frontier | one judge per criterion vs the running app |
| `recovery_director` / `recovery_csuite` | standard / capable | recovery-ladder councils (Tier 2 / Tier 3) |

## Input Documents

HPC accepts up to four input documents. All are optional except PRD, but each unlocks richer planning:

| Document | Purpose in HPC |
|---|---|
| **PRD** *(required)* | Product requirements — drives epic decomposition and requirement coverage checks |
| **SPEC** | API shapes, data models, auth contracts — feeds directly into contract definitions |
| **DESIGN** | Component tree, UI patterns, style guide — drives UI task decomposition and visual validation |
| **TESTING** | E2E scenarios, acceptance criteria, user flows — drives Phase 4 test generation |

Copy all provided documents to `hpc-workspace/input/` at the start of every run.

## Workspace Layout

```
hpc-workspace/
├── input/                  # PRD, SPEC, DESIGN, TESTING docs
│   └── corpus-index.yaml   # One-paragraph summary per doc (passed to councils)
├── manifest/
│   ├── manifest.yaml
│   ├── epics/
│   ├── task-groups/
│   ├── tasks/
│   ├── contracts/
│   ├── deliberations/
│   ├── build-commands.yaml      # typecheck / build / test / serve / e2e
│   └── infra-requirements.yaml  # Detected infrastructure needs (written in Step 9)
├── wiki/
│   ├── file-index.yaml
│   ├── contract-index.yaml
│   ├── progress.yaml
│   ├── verification-report.yaml
│   └── triage-report.yaml
├── output/                 # Generated source code (staging area — deployed to project root in Step 16c)
│   ├── emulator/           # Phase 4 runtime state (ports.json, .env.test, app-pid.txt)
│   ├── e2e/                # Generated Playwright suite
│   │   ├── tests.spec.ts
│   │   ├── page-objects/
│   │   └── playwright.config.ts
│   ├── screenshots/        # Visual captures from Phase 4
│   └── wiki/               # Phase 4 reports (e2e-report.yaml, BUILD-REPORT.md)
└── store/
    └── state.json
```

`hpc-workspace/` is per-build **scratch** — manifest, store, wiki, logs, and the `output/` staging buffer. The finished product does not live here: it lives at the **project root** (the deploy target of Step 16c), which carries a `.hpc/project.json` identity so successive builds share one tree rather than each siloing its own copy. The **structure profile** (resolved from `tech_stack`) decides the framework-standard directory layout of that project root — see `references/structure-profiles/` for the per-framework profiles.

---

## Phase 1: Planning Compiler

Read `references/council-protocols.md` before running any council.
Read `references/personas.md` before constructing any sub-agent prompt.
Read `references/manifest-schema.md` before validating any manifest artifact.

### Step 1: Input Ingestion

1. Copy all user-provided documents to `hpc-workspace/input/`
2. Create a corpus summary — write a 1-paragraph summary per doc to `input/corpus-index.yaml`:
   - `prd`: requirement overview, key user goals, REQ-NNN IDs present
   - `spec`: API surface, data models, auth strategy (if provided)
   - `design`: component hierarchy, styling approach, page/view list (if provided)
   - `testing`: E2E scenario count, critical user flows, acceptance thresholds (if provided)
3. This corpus index is what gets passed to councils — not the full documents

#### Step 1b: Synthesize REQ-IDs (plan completeness)

A PRD with zero `REQ-NNN` IDs makes the Gate 1 coverage check pass vacuously. Synthesize them from the
heading structure before any council runs (existing author IDs are preserved untouched):

```bash
node scripts/inject-req-ids.js --prd input/prd.md --output input/derived-prd.md
```

Downstream steps use `input/derived-prd.md` as the PRD. The original is preserved at `input/prd.md`.

#### Step 1c: Corpus filter + deferred-scope (plan completeness)

Classify the corpus into what THIS build addresses vs what is intentionally deferred, capturing the
deferral as a first-class artifact (so it cannot silently reappear as council disagreement):

```bash
node scripts/corpus-filter.js \
  --input-docs input/ \
  --build-target "@input/build-target.txt" \
  --output-corpus input/scope-corpus.md \
  --output-deferred input/deferred-scope.yaml \
  --model corpus_filter
```

Writes `input/scope-corpus.md` (in-scope) and `input/deferred-scope.yaml` (deferred, with
`depends_on_current_build` links Gate 1 verifies).

### Step 2: C-Suite Council (frontier tier)

```bash
node scripts/subagent.js \
  --persona csuite \
  --model csuite_council \
  --input input/corpus-index.yaml \
  --input-docs input/ \
  --output-dir manifest/epics/ \
  --phase planning
```

The C-Suite council has access to all four document summaries. The SPEC doc's API shapes inform contract skeleton definitions; the DESIGN doc's component list informs functional area assignment; the TESTING doc's critical flows inform acceptance criteria.

Split output:
```bash
node scripts/split-council-output.js \
  --input manifest/epics/csuite-output.yaml \
  --manifest-dir manifest/ \
  --tier csuite
```

**Expected outputs:** `manifest/epics/EPIC-NNN.yaml` (including `E-GLUE-000` when the stack needs a boot layer), `manifest/manifest.yaml` (seeded with `tech_stack`), `manifest/architecture.yaml`, `manifest/dag-skeleton.yaml`, `manifest/functional-areas.yaml`

The C-Suite prompt now requires a machine-readable `tech_stack`, a glue epic (`E-GLUE-000`) owning the boot layer for any `api_server`/`web_ui`/`ssr_app` stack, and a `deferral_disposition` on every `deferred` decision. `split-council-output.js` seeds `tech_stack` into `manifest/manifest.yaml` so Gate 1 (pre-freeze) can read it.

**You receive:** `ok` or `err:[description]`

On error: read the description, fix the issue, retry.

#### Step 2b: Extract + classify acceptance criteria (prep for Phase 5)

```bash
node scripts/extract-acceptance.js \
  --prd input/derived-prd.md \
  --scope-corpus input/scope-corpus.md \
  --output manifest/acceptance-criteria.yaml \
  --model acceptance_extract
```

Each criterion is classified `observable` (judgeable directly by the M6 acceptance harness) or
`requires-decomposition` (gets explicit sub-criteria). Gate 1 (`--completeness`) requires this file.

#### Step 2c: Author build-commands (boot_smoke)

```bash
node scripts/emit-build-commands.js --manifest-dir manifest/
```

Derives `manifest/build-commands.yaml` (`typecheck`/`build`/`test`/`boot_smoke` + `required_phases`)
deterministically from the seeded `tech_stack`, picking the per-stack `boot_smoke` template (api_server →
server start + `curl /health`; web_ui → vite preview + curl; etc.). This gives Gate 1's `boot_smoke`
requirement (and Phase 3) a target. It does **not** overwrite an existing `build-commands.yaml` (a council
or operator may have authored a better one with the real health endpoint); pass `--force` to regenerate.

### Step 3: Validation Gate 1

```bash
node scripts/manifest-validate.js --gate 1 --manifest-dir manifest/ \
  --prd input/derived-prd.md --completeness
```

Gate 1 (base) checks: every PRD requirement maps to an epic · every epic has acceptance criteria · epic DAG is acyclic · every epic has at least one functional area.

Gate 1 (`--completeness`, autonomous mode) additionally checks: `tech_stack` present and non-empty · glue epic `E-GLUE-000` present when the stack declares a boot layer · every `deferred` decision carries a `deferral_disposition` · `deferred-scope.yaml` entries are consistent with current-build epic outputs and not also present in acceptance criteria · `acceptance-criteria.yaml` is populated. It also reports the REQ-AUTO synthesis ratio. Omit `--completeness` for the legacy/supervised path (behaves exactly as before).

Fix failures before proceeding.

### Step 4: Director Councils (standard tier) — **LINEAR (serial)**

The manifest is the single source of truth. C-Suite and Director tiers run **linearly** so each Director
reads the manifest *as it stands* (the contracts prior Directors already wrote) and binds/reuses across
areas instead of racing — this is what prevents cross-area contract drift. **Split each Director's output
into the manifest before the next Director runs**, so the next one can see it:

```bash
for area in $(node scripts/list-areas.js manifest/functional-areas.yaml); do
  node scripts/subagent.js \
    --persona director \
    --model director_council \
    --input manifest/epics/ \
    --input manifest/architecture.yaml \
    --area "$area" \
    --manifest-dir manifest/ \
    --tools "Bash" \
    --output-dir "manifest/task-groups/director-$area/" \
    --phase planning            # NO trailing & — run one at a time
  node scripts/split-council-output.js \
    --input "manifest/task-groups/director-$area/director-output.yaml" \
    --manifest-dir manifest/ \
    --tier director              # splice into the manifest so the NEXT Director sees these contracts
done
```

Each Director is **manifest-aware** (`--manifest-dir` + `--tools "Bash"`): it calls `manifest-cli.js
surfaces`/`list` to learn the canonical contracts already in the manifest and reuses them, and `mint-id.js`
for genuinely-new IDs. Per-area output dirs (`director-$area/`) keep raw outputs separate. If a Director
returns malformed output (no `task_groups:` after split), re-run just that area (usually a transient lapse).

Engineers (Step 6) run in **parallel** — by then the contract set is finalized and read-only; each engineer
council only *reads* contracts and *writes its own* tasks (distinct files), so there is no write contention.

**ID minting (canonical names at the source):** Director/Engineer council prompts instruct the council to
call `node scripts/mint-id.js --manifest-dir manifest/ --type <task_group|contract|task> --area <AREA>`
(via the Bash tool) for every artifact id and paste the returned `GRP-/CONTRACT-/TASK-` id verbatim, rather
than inventing names. `mint-id.js` is parallel-safe (locked counter) so concurrent area councils don't
collide. As a backstop, run `node scripts/enforce-naming.js --manifest-dir manifest/ --check` after the
split (and `--fix` to normalize any drift).

Directors receive SPEC interface schemas when defining contracts, so contract schemas are grounded in the actual API shapes rather than guessed.

**Expected outputs:** `manifest/task-groups/GRP-{AREA}-NNN.yaml`, `manifest/contracts/CONTRACT-{DOMAIN}-NNN.yaml`, `manifest/ownership.yaml`

### Step 5: Validation Gate 2

```bash
node scripts/manifest-validate.js --gate 2 --manifest-dir manifest/
```

Gate 2 checks: every epic has task groups · every cross-domain boundary has a contract · no namespace has multiple owners · contract schemas parse correctly · task group DAG is acyclic · **every contract has a non-empty `surface:` block** with structured method/endpoint/type entries (not just a prose `definition:`) · **`definition:` and `surface:` agree** (every method named in the definition appears in the surface, and vice versa — if a Director council writes a prose IDL that introduces a symbol not in `surface:`, that's a malformed contract).

The `surface:` requirement is what makes contracts binding downstream. A contract whose surface only says `list()` cannot be silently consumed as `list_jobs()` by any worker — the per-task validator and Gate 3 cross-check enforce this. Without `surface:`, contracts are advisory and integration drift survives to Phase 4. See `references/manifest-schema.md` "Binding rule".

### Step 5b: Cross-Epic Contract Reconciliation (run BEFORE engineers)

```bash
node scripts/reconcile-contracts.js \
  --manifest-dir manifest/ \
  --model standard
```

Parallel Director councils for adjacent areas frequently produce overlapping contracts (same endpoint or method name defined twice under different contract IDs). If engineers run against the unreconciled set, each one writes tasks against a different contract and the consumer↔producer symbol names diverge — Gate 3 catches the drift, but only after the engineer outputs have already been generated, forcing a re-run.

**Run reconciliation here, before engineer dispatch.** The script:

1. Detects surface-symbol overlaps across contracts (same `kind:name` pair, where kind ∈ {ENDPOINT, METHOD} — identity-defining kinds only; shared TYPEs do not signal duplication)
2. Computes connected components and merges each cluster into a single canonical contract (heuristic: producer-area match + largest surface wins)
3. Rewrites every task-group's `contracts_consumed`/`contracts_produced` references from absorbed IDs to the canonical
4. Archives absorbed contract files to `manifest/_raw/reconciled/`

Returns `ok:reconciliation complete (N clusters merged, M name overlaps flagged)` or `err:[unresolved conflicts]`.

After reconciliation, re-run **Gate 2** to catch any namespace conflicts that the rewrite exposed. Only when Gate 2 is green do you proceed to Step 5d.

### Step 5d: Module-Path Manifest (run AFTER Director, BEFORE Engineer)

```bash
node scripts/module-path-emit.js \
  --manifest-dir manifest/ \
  --output manifest/module-paths.yaml
```

Reads `tech_stack` and the planned file tree and emits the canonical logical-name→path map, `@/` alias
anchors, and location conventions. Engineer councils receive this as a required input so workers consult it
before deciding any import path — closing the "workers independently invent module paths" drift class. It also resolves and records the **structure profile** (`structure_profile:` plus a `layout:` map of role → standard directory) into `module-paths.yaml`, which the Engineer councils follow when assigning `file_path` and which Gate 4 enforces.

### Step 6: Engineer Councils (standard tier) — parallel

```bash
node scripts/dispatch-engineers.js \
  --manifest-dir manifest/ \
  --model engineer_council \
  --output-dir manifest/tasks/

for d in manifest/tasks/engineer-*; do
  node scripts/split-council-output.js \
    --input "$d/engineer-output.yaml" \
    --manifest-dir manifest/ \
    --tier engineer
done
```

**Expected outputs:** `manifest/tasks/TASK-{AREA}-NNNN.yaml`, `manifest/file-tree.yaml`, `manifest/contract-xrefs.yaml`

### Step 7: Validation Gate 3

```bash
node scripts/manifest-validate.js --gate 3 --manifest-dir manifest/
```

Gate 3 checks: every task group has atomic tasks · no two tasks write the same file · every contract reference exists · full task DAG is acyclic · **declaration-level contract symmetry**: every symbol in any task's `contracts_consumed[].invokes` appears in some other task's `contracts_produced[].implements` for the same contract, AND every entry in every contract's `surface:` is claimed by at least one producer task's `implements`.

Gate 3 operates on task *declarations* only — it runs at the end of the Engineer council phase, before any code is written. By the time execution starts, every consumer/producer pair has been verified to *promise* a matching surface. Asymmetry at this gate is a hard failure — fix the contract surface, the consumer enumeration, or the producer task, then re-validate.

The corresponding *runtime* symmetry check — does the emitted code actually deliver and consume the declared symbols? — happens deferred per-pair at execution time, not at this gate (see "Deferred contract-symmetry checks" under Step 12).

### Step 7b: Validation Gate 4 (Layout)

```bash
node scripts/manifest-validate.js --gate 4 --manifest-dir manifest/
```

Resolves the framework **structure profile** from `tech_stack` (+ `infra-requirements.yaml`, or an explicit `structure_profile:` in `manifest.yaml`) and checks every task's `file_path` against it. Catches framework-standard layout violations the uniqueness-only Gate 3 cannot — e.g. a `pages/`-router route under an app-router Next.js profile, a server file outside `src/server/`, or a Go entrypoint outside `cmd/`. Returns `ok` or `err:gate_4_failures:` with a `→ suggest '<path>'` per violation. The `generic` profile (unknown/unsupported stack) enforces nothing, so this gate is a safe no-op when there is no convention to apply. Fix the offending `file_path`(s) and re-run before freezing.

### Step 8: Reconciliation Re-sweep (post-Gate-3, optional)

```bash
node scripts/reconcile-contracts.js \
  --manifest-dir manifest/ \
  --model standard
```

Reconciliation primarily runs at **Step 5b** (before engineers) so engineers see the final symbol set. A second pass here is optional — it catches any new overlap that Gate 3 surfaced (e.g. an engineer council manually escalated and created a new contract). Returns `ok` if nothing left to merge.

### Step 9: Infrastructure Detection

```bash
node scripts/detect-infra.js \
  --manifest-dir manifest/ \
  --input-docs input/ \
  --output manifest/infra-requirements.yaml
```

Reads `manifest/architecture.yaml` and the SPEC/PRD docs to identify what the built application needs at runtime, and which emulation strategy to use for each:

| Infrastructure | Emulation Strategy |
|---|---|
| Firestore / Firebase Auth / Firebase Storage | `firebase emulators:start` |
| PostgreSQL | `docker run postgres:15` |
| MySQL | `docker run mysql:8` |
| Redis | `docker run redis:7` |
| Supabase | `npx supabase start` |
| SQLite | None (in-process) |
| Next.js / Nuxt / SvelteKit SSR | `next dev` / `nuxt dev` / `vite dev` |
| Plain Express / Fastify API | Direct node start |

Also extracts required environment variable names (not values) so `.env.test` can be scaffolded.

### Step 9b: Plan-Completeness Preflight (run BEFORE freeze)

```bash
node scripts/plan-preflight.js \
  --manifest-dir manifest/ \
  --output wiki/plan-preflight-report.yaml
```

Verifies that every consumed contract has a producer task and every consumed symbol has an implementing
task — the class of gap that produced 30 post-freeze patch tasks in Vektor. Genuine known gaps are marked
`known_gap: true` (with `known_gap_reason:`) on the consuming task and counted, not blocked. Any unresolved
contract or symbol that is NOT a known gap blocks the freeze.

### Step 10: Manifest Freeze

```bash
node scripts/manifest-freeze.js --manifest-dir manifest/
```

Sets `status: APPROVED` in `manifest.yaml`. Generates the wiki hierarchy. After this point the manifest is read-only except via escalation patches.

---

## Phase 2: Execution

### Step 11: Initialize Task Store

```bash
node scripts/task-store.js init --manifest-dir manifest/ --store store/state.json
```

### Step 12: Execution Loop

```bash
node scripts/execute.js \
  --store store/state.json \
  --manifest-dir manifest/ \
  --output-dir output/ \
  --wiki-dir wiki/ \
  --worker-model worker \
  --validator-model schema_validator \
  --integration-validator-model integration_validator \
  --escalation-model escalation
```

Workers receive their task spec, relevant contracts, and — for UI tasks — the relevant DESIGN doc sections as additional context so naming, layout, and styling match the design intent.

**Concurrency (M3 §3.1):** parallelism defaults to a detected ceiling — `min(cpus×20, freemem/100MB, 250)` — logged at dispatch as `ceiling=N limit=<bound>`. Override with `--max-concurrent N` (alias `--max-parallel`). The 250 hard cap keeps simultaneous `claude` calls under API rate limits.

**Crash capture (M3 §3.2):** a worker subprocess that crashes (non-zero exit, timeout, no structured output) has its stderr/stdout captured to `wiki/worker-crashes/<task>-<ts>.log` with a classified `crash_reason` (`structured_error|empty_output|timeout|oom|rate_limit`). The `worker-err` log event carries the reason.

**Producer pre-validation (M3 §3.3):** a producer with ≥5 dependents is run through the `integration_validator` tier (deep contract validator) before its COMPLETE transition unblocks consumers — a failure routes it through normal failure handling so broken producer output never propagates.

The execution loop internally:
1. On first entry, runs `rescueEscalated()` — sweeps ESCALATED tasks through `blockOriginator()`
2. Queries for PLANNED tasks with all predecessors COMPLETE
3. Forms maximum-parallelism batch
4. Locks (PLANNED → LOCKED), assembles payloads, dispatches workers in parallel
5. For each completed worker: runs `normalize-output.js`, then schema validation, then integration/UI validation
6. On `ok`: marks COMPLETE, updates wiki, **enqueues deferred contract-symmetry checks** (see below)
7. On `err` (structural failure): marks BLOCKED, mints fork, routes to deliberation pipeline
8. Loops until all tasks COMPLETE or unresolvable forks remain

### Deferred contract-symmetry checks

The per-task Schema Validator only performs LOCAL contract checks (does the file implement its declared `produced.implements`? does it only invoke symbols listed in `consumed.invokes` ∩ contract surface?). It does NOT cross-check that a consumer's `invokes` actually has a delivering producer — that's a cross-task check that depends on both sides being COMPLETE.

The orchestrator handles cross-side symmetry asymmetrically through time:

1. When task T (any side of a contract C) is marked COMPLETE, find all peers of T across C — every producer of any symbol in T's `invokes` (if T is a consumer) and every consumer that references any symbol in T's `implements` (if T is a producer).
2. For each peer P: if P is COMPLETE, fire a deferred symmetry check between T and P (the file pair) right now. If P is anything else (PLANNED, LOCKED, IN_PROGRESS, BLOCKED, ESCALATED), do nothing — the symmetry check will fire when P transitions to COMPLETE.
3. A deferred symmetry check that fails:
   - Identify which side drifted (producer's emitted symbol doesn't match consumer's invocation, or consumer invokes a symbol the producer didn't deliver)
   - Mark the *drifted* side BLOCKED (not the side that's already shipped clean code matching its declared spec — that one is faultless)
   - Route to fork with `escalation_type: CONTRACT_CONFLICT`

**Critical rule for in-flight execution: never fail a task because its counterpart isn't done yet.** The asymmetry of completion order is a normal property of the DAG — when consumers run before producers (which they shouldn't given dependency edges, but can in weird DAG topologies) or vice versa, both sides should be allowed to complete and the symmetry check is the responsibility of the orchestrator at the join point, not of the per-task validator at fan-out time. Premature symmetry failures are an orchestrator bug.

Monitor:
```bash
node scripts/task-store.js status --store store/state.json
# [COMPLETE: N] [IN_PROGRESS: N] [PLANNED: N] [ESCALATED: N] [BLOCKED: N]
```

### Autonomous continuous operation (M4)

In autonomous mode, pass `--auto-continue` (or `--run-config run-config.yaml` with `auto_continue: true`)
to `execute.js`. See `references/run-config.md`. This removes the human from inter-run gaps:

```bash
node scripts/execute.js [...standard args...] \
  --auto-continue \
  --run-config manifest/run-config.yaml
```

- **Auto-continue (§4.1):** after a run segment leaves blocked forks pending, `execute.js` auto-runs
  `deliberate-fork` and re-enters the loop after a `cooloff_minutes` pause — no human restart. If the
  run-segment worker-error rate exceeds `abort_threshold` (default 0.70 — catches "every worker crashing"),
  it writes `RUN-ABORTED.md`, notifies, and halts. Consecutive runs are capped at `max_run_count`.
- **Progress watchdog (§4.2):** if no task transition is observed within `watchdog_stall_min` (default 15)
  while workers are active, it dumps `wiki/stall-diagnostic-<ts>.yaml` and triggers recovery — catching the
  busy-but-not-progressing failure mode the per-task `reset-stale` can't see.
- **Heartbeat (§4.3):** one stdout status line every `heartbeat_sec` (default 30) — pure observability.
- **Halt notifications (§4.4):** `notify-halt.js` commits the halt artifact with an `[HPC-HALT]` prefix and
  POSTs the webhook if configured. Only halt states notify (see run-config.md).

Without `--auto-continue`, every one of these is inert and `execute.js` runs exactly as in supervised mode.

### Step 13: Final Assembly

```bash
node scripts/assemble.js --output-dir output/ --wiki-dir wiki/ --manifest-dir manifest/
```

Structural check — file existence, frontmatter, synopsis. Does NOT run build or test commands.

### Step 13b: Import-Graph Check (run after assembly, before verify-build)

```bash
node scripts/import-graph-check.js \
  --output-dir output/ \
  --manifest-dir manifest/ \
  --report wiki/import-graph-report.yaml
```

Parses every generated source file's imports and verifies each cross-file local import resolves to a
file some task actually produces. Orphan imports (a worker imported a module no task creates — the
integration-shim failure class) **block Phase 3 entry**. External/stdlib/package imports are ignored.
Python and TypeScript/JavaScript are resolved; Rust/Go and others are recorded as `stack-not-supported`
(non-blocking). Returns `ok:import-graph clean` or `err:import_graph:<N> orphan import(s)`.

---

## Phase 3: Static Verification & Repair

Per-task validators caught contract drift. Phase 3 catches failures that only show up when the full codebase compiles and runs together. Loop: **verify → triage → patch-or-block → re-verify**, capped at 3 rounds.

### Step 14: Verify Build

```bash
node scripts/verify-build.js \
  --output-dir output/ \
  --manifest-dir manifest/ \
  --wiki-dir wiki/
```

Command discovery: `--build-commands` override → `manifest/build-commands.yaml` → auto-detect from `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod`.

Runs typecheck → build → test → **boot_smoke**. Writes `wiki/verification-report.yaml`. The `all_green` field is authoritative.

**`boot_smoke` (M2):** the phase that proves the product *runs*, not just compiles — start the server/UI and `curl` it, or invoke the CLI. Mandatory whenever `tech_stack` declares `api_server`/`web_ui`/`ssr_app`/`cli` (Gate 1 `--completeness` enforces that `build-commands.yaml` defines it). A **required phase that is skipped counts as a failure** (`all_green: false`) — a required phase with a null command is a manifest error. Phases are required when listed in `build-commands.yaml`'s `required_phases:` (boot_smoke is auto-required for runnable stacks); everything else defaults to non-required, so legacy manifests behave exactly as before.

#### Picking the `typecheck:` command (do not skip this — it is the cheapest place to catch integration drift)

The `typecheck:` slot must actually exercise cross-module resolution. If it only validates syntax, every cross-area drift the engineer councils introduced (different naming conventions, missing modules referenced across area boundaries) survives Phase 3 and lands in Phase 4 as runtime failures — expensive to chase, one shim at a time.

Pick the command per language:

| Language | Use | Don't use |
|---|---|---|
| Python | `mypy --ignore-missing-imports <pkg1> <pkg2> ...` or `pyright <dir>`. At minimum, an import walk: `python -c "import pkg.a; import pkg.b; ..."` over every entry-point module — catches `ModuleNotFoundError`, attribute-on-wrong-type, signature mismatches at import time. | `python -m compileall` — this is **bytecode compilation**, not typechecking. It catches syntax errors only and reports nothing about imports or cross-module references. |
| TypeScript | `npx tsc --noEmit` or `npx tsc -p tsconfig.json --noEmit` | `node -c file.js` |
| Rust | `cargo check --all-targets` | `cargo build` alone (build catches the same things but slower) |
| Go | `go vet ./...` + `go build ./...` | `gofmt` alone |

**For Python projects specifically:** if no mypy/pyright config exists, write the typecheck command as a defensive import walk. Example for a FastAPI project:

```yaml
typecheck: "python -c 'import app.api.main; import cli; import pipeline.orchestrator.runner; import db; import lib.whisper_service'"
build: "python -m compileall -q ."
test: "python -m pytest -q tests/"
```

This catches ~80% of cross-area engineer-council drift on the first Phase 3 pass, which the triage loop can then auto-patch via the `patch` tier. Skipping it shifts the same work to manual Phase 4 chase.

### Step 14b: Deterministic tsc-Suggestion Sweep (TS/JS only — run on a failed verify, before LLM triage)

```bash
node scripts/tsc-suggest-fix.js --project output/ --apply
```

When `verify-build` fails on a TypeScript typecheck, run this **before** spending an LLM triage round.
It harvests the TypeScript compiler's OWN `Did you mean …?` suggestions — which are high-confidence and
compiler-authored — and applies them via the `edit-ops.js` primitives. Only three self-suggested classes
are touched: default→named imports (TS2613), identifier typos (TS2551/2552), and quoted-literal enum
fixes (TS2769/2322, e.g. `sameSite: "Lax"` → `"lax"`). Everything else is reported and **skipped** (no
silent caps) — it never guesses. Ambiguous edits (token appears >1× and not on the reported line) are
skipped too. This is the same deterministic-first principle as `import-graph-check` and
`producer-symbol-check`: clear the mechanical errors for free, then let LLM triage handle what genuinely
needs judgment. Re-run `verify-build` after; always exits 0 (best-effort — `verify-build`'s `all_green`
stays authoritative).

### Step 15: Triage Failures

```bash
node scripts/triage-failures.js \
  --manifest-dir manifest/ \
  --output-dir output/ \
  --wiki-dir wiki/ \
  --store store/state.json \
  --triage-model triage \
  --patch-model patch \
  --round 1
```

The `triage` tier issues a verdict per failure cluster: `quick_fix:<directive>` (the `patch` tier applies it inline) | `block:<reason>` (fork pipeline) | `noise:<reason>` (recorded only).

### Step 16: Resolve Forks & Re-verify

```bash
node scripts/deliberate-fork.js --manifest-dir manifest/ --store store/state.json --all
node scripts/execute.js [...]
```

Loop back to Step 14. **Round cap = 3.** Surface remaining failures to the user after round 3.

### Step 16b: Final Assembly Re-Run

```bash
node scripts/assemble.js --output-dir output/ --wiki-dir wiki/ --manifest-dir manifest/
```

Only proceed to Phase 4 when Phase 3 reaches `all_green: true`.

### Step 16c: Deploy to Project Root

Once Phase 3 is green, materialize the staged output into the project tree:

```bash
node scripts/deploy-output.js \
  --output-dir hpc-workspace/output/ \
  --manifest-dir manifest/ \
  --build-id "$(date +%s)" \
  --overwrite
```

This resolves a **stable project identity** (canonical root + structure profile + build history, recorded in `<projectRoot>/.hpc/project.json`) and lands the generated code there. Because the project is stable, a *second* build of the same product deploys into the **same tree and extends it** instead of siloing a fresh copy — pass the same `--target-dir`/`--project-id` to bind to it. Each deploy records which files it wrote, so a later build overwriting an earlier build's file is reported as a `conflict` rather than silently clobbered.

- `--manifest-dir` lets deploy read `tech_stack` to pick the structure profile and name the project. Omit `--target-dir` to default to the parent of `hpc-workspace/` (the project location); pass `--target-dir <dir>` or `--project-id <id>` to target an existing project explicitly.
- `--no-project` falls back to the legacy positional copy (no `.hpc/` identity).
- `--normalize-layout` (opt-in) relocates any straggler files that aren't already at their profile-standard path (off by default — relocation can rewrite import paths; the Gate 4 layout check below is the preferred way to get this right at planning time).
- `.hpc/` is added to the project's `.gitignore` automatically.

Returns `ok:deployed=<N>,skipped=<S>,conflicts=<C>,root=<projectRoot>` or `err:[description]`.

Writes `hpc-workspace/wiki/deploy-log.yaml` listing every file deployed, skipped, and any conflicts.

**Only proceed to Phase 4 after deploy succeeds.** Phase 4 (app-serve, integration tests) runs from the project root — `app-serve.js` should use `--app-dir ./` (the project root), not `--app-dir hpc-workspace/output/`.

---

## Phase 4: Runtime Verification

Phase 3 proves the codebase compiles and unit tests pass. Phase 4 proves it **runs** — with real infrastructure emulators, real HTTP traffic, and end-to-end user flows validated by Playwright.

### Phase 4 Availability Check

Before running any Phase 4 step, confirm the required tooling is present for this project's infra needs:

```bash
# Check what's needed
cat manifest/infra-requirements.yaml | grep "emulator_tools_required" -A 4
```

If `docker: true` and Docker is not running → Phase 4 cannot proceed. Write `output/emulator/phase4-skipped.txt` with reason `docker_not_running`, run Step 21 with `--phase4-skipped "docker_not_running"`, and tell the user.

If `firebase: true` and `firebase` CLI is not installed → same pattern.

If nothing requires Docker or Firebase → Phase 4 is lightweight and should always succeed.

**A Phase 3 build is a complete deliverable.** Phase 4 adds runtime confidence but is not required for the code to be correct.

### Step 17: Start Infrastructure Emulators

```bash
node scripts/emulator-start.js \
  --manifest-dir manifest/ \
  --output-dir output/
```

Reads `<manifest-dir>/infra-requirements.yaml` and starts each required emulator. Generates any missing config files (e.g. `firebase.json`, `.env.test` with emulator connection strings). Writes `output/emulator/ports.json` with the actual bound port for each service (plus `output/emulator/pids.json`). Health-checks each emulator (60-second timeout per service, override with `--timeout <sec>`).

Returns `ok:started=<services>` or `err:emulator_failed:[reason]`.

**Graceful degradation:** If emulator-start.js returns any `err:`, do NOT abort the run. Instead:
1. Write `output/emulator/phase4-skipped.txt` with the error reason
2. Jump directly to Step 21 (Build Report) — pass `--phase4-skipped "<reason>"` 
3. Tell the user clearly: "Phase 4 skipped — [reason]. The Phase 3 build is complete and the code is in output/. To run Phase 4 later: ensure [missing tool] is installed and re-run from Step 17."

Phase 4 is optional. A Phase 3 build (compiled, type-checked, unit tests passing) is a complete and useful deliverable.

### Step 18: Start Application

Runs from the project root **after Step 16c has deployed the files there**. The app lives at the project root now, not in `hpc-workspace/output/`, so point `--app-dir` at the project root (`../` relative to `hpc-workspace/`):

```bash
node scripts/app-serve.js \
  --app-dir ../ \
  --manifest-dir manifest/ \
  --output-dir output/ \
  --port 3000
```

Detects the framework from `manifest/infra-requirements.yaml` or the deployed project root's contents, injects emulator environment variables from `--env-file` (default: `output/emulator/.env.test`, written by emulator-start.js), starts the app, and polls `http://localhost:3000` until responsive (90-second timeout, override with `--timeout <sec>`). Writes PID to `output/emulator/app-pid.txt`, the bound URL to `output/emulator/app-url.txt`, and server logs to `output/emulator/app-serve.log`.

Returns `ok:url=http://localhost:<port>` or `err:app_not_ready:[reason]`.

On `err`: read `output/emulator/app-serve.log`, run Phase 3 repair first if the error is a compile-time issue.

On `err:app_not_ready`: If this is a startup failure unrelated to Phase 3 (e.g. missing env var, port conflict), write `output/emulator/phase4-skipped.txt`, jump to Step 21 with `--phase4-skipped`, and report to user. Do NOT re-run Phase 3 — the code is fine.

### Step 19: Generate E2E Tests

```bash
node scripts/e2e-generate.js \
  --input-dir input/ \
  --manifest-dir manifest/ \
  --output-dir output/ \
  --app-url http://localhost:3000 \
  --model e2e_generate
```

Calls Claude (the `e2e_generate` tier) with the TESTING doc's user flows (found in `--input-dir` as `TESTING.md` / `testing.md` / `test.md` / `TEST.md` / `e2e.md`) plus the manifest's contracts, architecture, and infra YAML. The script appends `e2e/` to `--output-dir` itself — pass `--output-dir output/`, NOT `--output-dir output/e2e/` (that would nest `e2e/e2e/`). Produces:
- `output/e2e/tests.spec.ts` — single Playwright test file covering all flows from the TESTING doc
- `output/e2e/playwright.config.ts` — headless Chromium, base URL, screenshots on failure, 30s timeout
- `output/e2e/page-objects/` — one POM class per major page (if applicable)

If no TESTING doc exists in `--input-dir`, returns `err:testing_doc_not_found` — treat that like any other Phase 4 `err:` (graceful skip via Step 21 `--phase4-skipped`).

An optional `--human-guidance "<text>"` flag injects targeted instructions into the generation prompt (used for selector repair in Step 20).

Returns `ok:tests=<N>` or `err:[reason]`.

### Step 20: Run E2E Suite

```bash
node scripts/e2e-run.js \
  --output-dir output/ \
  --app-url http://localhost:3000
```

Optional: `--env-file <path>` (default: `output/emulator/.env.test`), `--timeout <sec>` (per-test, default 30), `--retries <n>` (default 1). All paths are derived from `--output-dir`: tests run from `output/e2e/`, screenshots land in `output/screenshots/`, the report in `output/wiki/e2e-report.yaml`.

Installs Playwright if needed, health-checks `--app-url`, then runs `npx playwright test`. The generated tests capture a full-page screenshot per scenario into `output/screenshots/`; Playwright additionally captures screenshots on failure.

Writes `output/wiki/e2e-report.yaml` with pass/fail counts, failure details, and screenshot paths.

Returns `ok:passed=<X>,failed=0,skipped=<Z>` when everything is green; `err:failed=<Y>,passed=<X>,skipped=<Z>` (exit code 1) when any test fails; `err:results_missing` if Playwright produced no results JSON.

On failures: read `output/wiki/e2e-report.yaml`. If the failure looks like missing functionality (feature not implemented), mint a fork. If it looks like a bad test selector or timing issue, re-run e2e-generate with the now-targeted guidance:

```bash
node scripts/e2e-generate.js \
  --input-dir input/ \
  --manifest-dir manifest/ \
  --output-dir output/ \
  --app-url http://localhost:3000 \
  --human-guidance "fix selector for X"
```

### Step 20b: E2E Failure Chase (tiered repair)

Run immediately after Step 20 if `e2e-run.js` returns any `err:` (e.g. `err:failed=N`). If Step 20 returns `ok`, skip this step entirely.

```bash
node scripts/e2e-chase.js \
  --e2e-dir output/e2e/ \
  --app-dir ./ \
  --app-port 3000 \
  --pid-file output/emulator/app-pid.txt \
  --output-file PHASE4-FAILURE-REPORT.md \
  --max-rounds 5 \
  --diag-dir output/e2e/_diag/
```

The chase loop escalates through four tiers: **Tier 1** (rounds 0–1, `e2e_chase_tier1`) dispatches a single-agent via `claude -p` with `Bash, Read, Edit, Write` tools — cheap and fast, resolves ~80% of failures (wrong selector, heading text mismatch, missing CSS class). **Tier 2** (round 2, `e2e_chase_tier2`) upgrades to a more capable tier and explicitly instructs it not to repeat the tier-1 approach — useful for cross-file contract drift or stale build-cache issues. **Tier 3** (round 3) runs a three-persona council (Senior Engineer → Critic → Synthesizer, all at the standard tier) that deliberates before the Synthesizer applies the patch; artifacts land in `output/e2e/_diag/round-3-patch.txt` and `round-3-decisions.yaml`. **Tier 4** (round 4) dumps all round artifacts to `PHASE4-FAILURE-REPORT.md` and stops — a human must take it from there.

Per-round artifacts written to `output/e2e/_diag/`:
- `round-N.txt` — captured failure context (Playwright output, `curl` response, server log tail, mtime sweep, `git diff --stat`)
- `round-N-patch.txt` — applied patch, or `"test-assertion weakened: <justification>"`
- `round-N-results.txt` — Playwright output after the patch

**Safety rails:** If a round's patch *increases* the failing-test count, the orchestrator restores the pre-patch file snapshot and advances to the next tier without accepting the regressed state. The `RESTART_DEV` sentinel (`output/e2e/_diag/RESTART_DEV`) triggers a kill-and-respawn of the dev server (using the PID in `--pid-file`) before the re-run. Re-running the script is idempotent — rounds with existing `round-N-results.txt` are skipped and the test suite is re-evaluated from the current state.

**Cost model (worst case):** Tier 1 ~$0.10–0.20, Tier 2 ~$1–2, Tier 3 ~$0.50, Tier 4 $0. All-tiers worst case: ~$2–3. Best case (round 0 fixes it): ~$0.05.

Returns `ok:rounds=<N>,passed=<P>/<T>` or `err:exhausted` (report written to `--output-file`).

### Step 21: Build Report

```bash
node scripts/build-report.js \
  --output-dir output/ \
  --manifest-dir manifest/
```

Optional: `--title "<text>"`, `--phase4-skipped "<reason>"` (when Phase 4 was skipped — see Steps 17–18). Reads the E2E report and screenshots from under `--output-dir` and writes the report to `output/wiki/BUILD-REPORT.md`. Returns `ok:report=<path>` or `err:[description]`.

Assembles a human-readable Markdown build report:
- Task completion counts
- Phase 3 static verification result
- Phase 4 E2E results (pass/fail + failure details)
- Inline screenshot links (home page + key flow captures)
- List of any remaining unresolved issues

### Step 22: Shutdown Emulators

Always run cleanup at the end, even on failure:
```bash
node scripts/emulator-start.js --shutdown --output-dir output/
node scripts/app-serve.js --shutdown --output-dir output/        # kills the app process group via output/emulator/app-pid.txt
kill $(cat hpc-workspace/dashboard.pid) 2>/dev/null || true   # stop the live dashboard
kill $(cat hpc-workspace/opencode-serve.pid) 2>/dev/null || true
```

---

## Phase 5: Acceptance (M6)

Runs after Phase 4 passes. Validates the built product against PRD **intent** — pass is pass, fail is fail.
This is the gate that makes "shipped with stub bodies" structurally impossible: the judge checks the
*running* product, so a stub that returns a placeholder or raises `not yet initialized` cannot pass a
runtime criterion. Read `references/acceptance-protocol.md` first.

```bash
node scripts/acceptance-run.js \
  --criteria manifest/acceptance-criteria.yaml \
  --app-url http://localhost:3000 \
  --code-dir ./ \
  --logs output/emulator/app-serve.log \
  --output ACCEPTANCE-REPORT.md \
  --wiki-dir wiki/ \
  --judge-model acceptance_judge
```

- One judge per criterion at the `acceptance_judge` (frontier) tier, with read-only tool access (Bash for curl/playwright/log reads, Read
  for code). Observable criteria are judged directly; `requires-decomposition` criteria pass only if every
  sub-criterion passes.
- Each judge (frontier tier) emits `pass:<evidence>` / `fail:<reason>`; per-criterion evidence lands in `wiki/acceptance/`.
- **All criteria must pass.** `ACCEPTANCE-REPORT.md: PASS` and (after M5 exhausts) `: FAIL` are both halt
  states → `notify-halt.js`. Any `fail` routes the judge bundle to **M5 recovery** (the failing criterion
  becomes the slice the ladder re-plans); recovery resolving the stub or Tier-4 declaring a `SPEC-DEFECT`
  is the only exit. There is no path that ships a FAIL as done.

Returns `ok:acceptance PASS ...` or `err:acceptance:<N> failed ...`. `build-report.js` reads
`ACCEPTANCE-REPORT.md` and makes the acceptance verdict the authoritative final status.

## Phase R: Autonomous Recovery (M5)

When validation fails after the existing repair tiers are exhausted, the system **re-plans** the affected
slice and re-executes rather than handing off to a human. Five tiers, escalating:

| Tier | Fires when | Action | Workspace |
|---|---|---|---|
| **1 Triage** | Phase 3 verify-build round cap (3) exceeded | `triage-failures.js` — quick_fix or route to Tier 2 (`--auto-deliberate` chains it) | in-place |
| **2 Director** | Tier 1 exhausted; slice = one epic | `deliberate-fork.js` council_tier=director; amend tasks/contracts in slice | in-place fork dir |
| **3 C-Suite** | Tier 2 exhausted OR slice spans >1 epic | `deliberate-fork.js` council_tier=csuite; may re-decompose epics | **fork workspace** (`fork-workspace.js`) |
| **4 Spec re-read** | Tier 3 exhausted | C-Suite re-reads the **original** corpus + full failure history → amended plan OR `SPEC-DEFECT.md` | **fork workspace** |
| **5 Halt** | Tier 4 emits `SPEC-DEFECT.md` | `spec-defect-report.js` + `notify-halt.js`; build stops with a diagnosis | n/a |

**How the tiers chain.** A fork carries its tier (`recovery_tier` in `origin.yaml`; Director=2, C-Suite=3).
`deliberate-fork.js` runs the council for that tier, then:
- **Diff guard (§5.6):** an amendment touching > 30% of tasks (Tier 2) / > 60% (Tier 3) is not merged —
  the fork escalates one tier (a council rewriting that much is at the wrong tier).
- **No progress:** a tier that produces no amendment escalates; at Tier 4 that emits `SPEC-DEFECT.md`.
- Every iteration is appended to `wiki/recovery-state.yaml`.

**Safety rails (the only thing that makes unbounded recovery safe):**
- **Loop detector (`loop-detector.js`, §5.3):** signature-stable (same task, same output twice) and
  slice-stable (3 iterations on one slice) → escalate; manifest-cycle (iteration N == N-2) → **halt**.
- **Iteration cap (`budget-tracker.js`, §5.4):** inferred from manifest size/complexity (small 3 / medium 5
  / large 10, +complexity bonuses, absolute cap 15; `recovery_iteration_cap_override` to force). Cap
  reached → halt.
- `execute.js`'s `triggerRecovery()` consults both around each deliberation pass and halts with a
  `SPEC-DEFECT.md` + notification when either fires.

The recovery driver runs automatically under `--auto-continue` (M4). Phase 4's `e2e-chase.js
--recover-on-exhaust` hands a Tier-4 chase exhaustion to the same ladder.

### Audit trail — `wiki/autonomous-decisions.yaml`

Every autonomous decision (tier escalation, workspace fork, halt) is appended here. Workspace snapshots at
`hpc-workspace.tier3-iteration-N/` (with the `hpc-workspace.current` symlink) let an operator diff exactly
what recovery changed across tiers.

## Autonomy & Safety Rails (cross-cutting)

**Default mode is autonomous.** Running the skill without flags drives the full loop to a halt state with a
**60-second post-freeze confirmation gate**: after M1 freezes the manifest, print a one-screen summary
(tech stack · epic/task/contract counts · glue-epic status · deferred-scope titles · acceptance-criteria
count) and "Proceeding to execution in 60 seconds. Any keypress pauses for review." No input in 60s →
proceed (pass `--auto-continue` to `execute.js`); a keypress → supervised mode for this run.

**Flags:**
- `--supervised` — disable autonomy; restore per-phase operator gating (omit `--auto-continue`).
- `--no-confirm` — skip the 60-second gate; proceed immediately (unattended/cron).
- `--resume` — main build paused (no halt artifact): resume from the last completed task (the store + DAG
  pick up where they left off). After a halt (`SPEC-DEFECT.md` / `SANITY-CAP-HIT.md` /
  `ACCEPTANCE-REPORT.md: fail`): open an inspection shell with state loaded; the operator decides next steps.

**The only halt states** are `ACCEPTANCE-REPORT.md` (PASS or, after M5 exhausts, FAIL), `SPEC-DEFECT.md`
(structural impossibility), `SANITY-CAP-HIT.md` (72h pathological loop), and `RUN-ABORTED.md` (worker-err
rate exceeded). Each triggers `notify-halt.js` (commit `[HPC-HALT]` + webhook). Everything else writes to
the audit log only.

**Sanity cap:** 72h of continuous execution with zero observable progress (no task COMPLETE, no recovery
iteration resolved) halts with `SANITY-CAP-HIT.md` (enforced in `execute.js` under `--auto-continue`).

**Workspace location:** always sibling-to-invocation — `./hpc-workspace/` and fork snapshots
`./hpc-workspace.tier3-iteration-N/` with the `hpc-workspace.current` symlink.

**Audit trail:** `wiki/autonomous-decisions.yaml` records every autonomous decision (the operator's primary
post-hoc debugging artifact). Rotate at 10MB into `wiki/autonomous-decisions-archive/` (future task).

## Delta builds & hardening (field-tested findings)

HPC is designed for from-scratch builds. Running it as a **delta against an existing codebase**, and
trusting its verdicts in general, requires the guardrails below. These are field-tested; several
correspond to script fixes already shipped (noted inline).

### Trust the gate, not `all_green`
- **`emit-build-commands.js` can emit a meaningless gate.** For a `node`/library stack it may produce
  `test: npm test` (which `--passWithNoTests`-skips with no DB) and leave `test` OUT of
  `required_phases` (only `typecheck`+`build`), with `boot_smoke=none`. That makes `all_green`
  vacuous — especially for a security/data boundary. **Always inspect `manifest/build-commands.yaml`
  after Step 2c.** If the project has a real test/integration suite, set `test:` to the command that
  actually exercises it (e.g. an ephemeral-DB integration run) and add `test` to `required_phases`.
- **`verify-build.js` (Phase 3) cannot run for a delta** when `output/` holds only the handful of
  generated files (no `package.json`/`node_modules`). The deterministic verify will no-op or error.
  For a delta, the real verification is: deploy to the project root (Step 16c) FIRST, then run
  `tsc --noEmit` + the real test suite **in the project tree**. Treat that, not Phase-3 `all_green`,
  as authoritative.
- **Cross-worker integration drift is invisible to typecheck/`all_green`.** Independent workers make
  incompatible assumptions across a boundary (e.g. one greps a SQL file for `PASSWORD '…'` to build a
  connection string while the role-provisioning worker created the role with no password). Only a
  runtime test that actually exercises the path catches this — bake that test in as a required gate.

### Non-code artifacts & convention/marker "contracts"
- **The per-task LLM validator used to false-fail non-code artifacts** (`.sql`/`.sh`/`.prisma`/
  migrations/`.gitkeep`) with `producer_symbol_name_mismatch`, even though the deterministic
  `producer-symbol-check.js` correctly exempts them (`ok:stack-not-supported`). **Fixed:** the
  validator prompt now has a NON-CODE ARTIFACT GATE (step 0) that skips the producer check for these.
  If a non-code task still blocks on a symbol mismatch, the artifact is usually fine — read it, and if
  good, accept via `node task-store.js complete --task-id … --worker orchestrator-accept`.
- **Don't let councils model conventions/markers as code-symbol contract surfaces.** Surfaces like
  "import the singleton", a module-path rule, `MIGRATION_REQUIRED`, or `DualRoleEnvVars` get `kind:
  CONST/TYPE` and are anchored to a `.gitkeep`/SQL file that can't export code → an unfixable mismatch.
  Fix at the manifest: empty that producer's `contracts_produced`, strip the contract from consumers,
  delete the contract file (it becomes a non-blocking orphan advisory), re-run Gate 3. Better: in the
  Director/Engineer prompts, only mint a contract surface for a symbol some real code file exports.

### After deploy — clean up & review
- **`deploy-output.js` no longer copies `*.symcheck.json` sidecars** (fixed). On older runs, delete
  them from the project tree post-deploy.
- **`normalize-output.js` now uses `//` for `.prisma`** (fixed) — previously it prepended a
  `#`-comment frontmatter block that is a Prisma syntax error breaking `prisma validate`/`migrate`.
  Still worth a glance: confirm no generated file carries a frontmatter block in a comment syntax its
  language rejects.
- **Exclude `hpc-workspace/` from the project's typecheck** (add to `tsconfig.json` `exclude` and
  `.gitignore`) — otherwise `tsc` typechecks the staging copies and reports duplicate-module /
  missing-relative-import errors that aren't real.
- **Always `git diff` the real tree against a pre-build baseline commit.** Review modify-in-place
  edits for clobbering (preserved exports, no dropped functionality) and flag worker deviations
  (e.g. a worker adding an optional param despite a frozen-signature constraint — usually
  backward-compatible, but call it out).

### Delta execution hygiene (recap of the delta-specific guardrails)
- `git`-baseline the working tree before execution so every worker change is diffable.
- Inject existing file content into tasks whose `file_path` already exists, with strong
  "MODIFY IN PLACE — do not rewrite" framing.
- After Engineer councils, reconcile duplicate/overlapping tasks (two councils covering one area
  produce multiple tasks writing the same file) into one canonical task per file before Gate 3.
- Right-size the worker model: the `cheap` tier thrashes on integration/cross-module/SQL/bash glue — use
  the `standard` tier (e.g. set those tasks to `worker_promoted`) for those task families.

## Error Handling

**Sub-agent returns `err:`** — Read the description. Common patterns:
- `err:contract_missing:CONTRACT-USER-001` → contract not in payload, re-assemble and retry
- `err:ambiguity:multiple valid interpretations` → escalation envelope, route to the `escalation` tier
- `err:scope_exceeded:task too large` → re-decompose at Director tier
- `err:dependency_missing:TASK-API-0023 not complete` → DAG ordering error, check store state
- `err:emulator_failed:firebase` → check `firebase-tools` install, run `firebase login`
- `err:app_not_ready` → read output/emulator/app-serve.log; run Phase 3 repair if compile-time issue
- `err:testing_doc_not_found` / `err:subagent_failed` → check the TESTING doc exists in input/ and is well-formed; Phase 4 graceful skip if unresolvable
- `err:docker_not_running` → Phase 4 graceful skip: write output/emulator/phase4-skipped.txt, jump to Build Report, tell user Docker is needed for Phase 4
- `err:emulator_failed:[service]` → Phase 4 graceful skip (same pattern) — don't retry more than once

**Gate validation fails** — Each failure is actionable: re-run the relevant council with clarified input.

**Escalation loop** — If a task escalates more than 3 times, surface to the user for manual guidance.

---

## Context Management

Non-negotiable: **never read full sub-agent output files into your context window.** Read only:
- Status lines (`ok` / `err:...`)
- Manifest metadata (epic names, task counts, DAG stats)
- File headers (frontmatter + synopsis only) when debugging
- `output/wiki/e2e-report.yaml` summary fields (not raw Playwright output)
- a screenshot from `output/screenshots/` to visually confirm the app rendered — open it in the terminal if possible

---

## Resumability

Task store persists to `store/state.json`. If a session ends mid-execution:
1. Run `node scripts/task-store.js status` to see current state
2. If mid-Phase 4: check output/emulator/phase4-skipped.txt — if present, Phase 4 was skipped intentionally; run build-report.js manually. If absent, re-run from Step 17 (emulators are stateless, safe to restart).
3. Execution loop picks up where it left off — COMPLETE tasks stay complete, LOCKED tasks reset to PLANNED via `reset-stale`
4. If deploy (Step 16c) completed, re-running it with `--overwrite` is safe — it will re-copy all files.

---

## Scripts Reference

| Script | Purpose |
|---|---|
| `subagent.js` | Generic sub-agent API caller |
| `split-council-output.js` | Splits monolithic council YAML into per-artifact files (seeds `tech_stack` into manifest.yaml) |
| `inject-req-ids.js` | Synthesizes `REQ-AUTO-NNN` IDs from PRD headings → `input/derived-prd.md` |
| `corpus-filter.js` | `corpus_filter`-tier corpus classifier → `input/scope-corpus.md` + `input/deferred-scope.yaml` |
| `extract-acceptance.js` | `acceptance_extract`-tier acceptance-criteria extractor/classifier → `manifest/acceptance-criteria.yaml` |
| `module-path-emit.js` | Emits canonical `manifest/module-paths.yaml` from tech_stack + file tree |
| `emit-build-commands.js` | Derives `manifest/build-commands.yaml` (incl. `boot_smoke`) from tech_stack |
| `manifest-cli.js` | Council-callable manifest accessor (list/get/surfaces/add/update) — manifest as source of truth |
| `mint-id.js` | Council-callable canonical ID minter (parallel-safe) — `GRP-/TASK-/CONTRACT-/EPIC-` |
| `enforce-naming.js` | Naming-convention gate (`--check`) + normalizer (`--fix`) for manifest artifact IDs |
| `plan-preflight.js` | Pre-freeze contract producer/symbol resolution → `wiki/plan-preflight-report.yaml` |
| `manifest-validate.js` | Runs validation gates 1–3 (`--completeness` adds M1 plan-completeness checks to Gate 1; `--strict-coverage` adds Gate 3 coverage_gap enforcement) |
| `import-graph-check.js` | Phase 3 pre-check — orphan cross-file imports block verify-build |
| `notify-halt.js` | Halt notification — commit (`[HPC-HALT]`) + webhook POST for halt artifacts |
| `fork-workspace.js` | **Recovery** — snapshot workspace at Tier 3+ (`hpc-workspace.tier3-iteration-N/`) |
| `budget-tracker.js` | **Recovery** — infer + track the recovery-iteration cap (absolute cap 15) |
| `loop-detector.js` | **Recovery** — signature/slice-stable + manifest-cycle non-convergence detectors |
| `spec-defect-report.js` | **Recovery** — emit `SPEC-DEFECT.md` halt diagnosis |
| `acceptance-run.js` | **Phase 5** — `acceptance_judge` (frontier) judge per criterion vs the running app → `ACCEPTANCE-REPORT.md` |
| `list-areas.js` | Lists functional areas from manifest |
| `dispatch-engineers.js` | Parallel dispatch for engineer councils |
| `reconcile-contracts.js` | Cross-epic contract reconciliation |
| `detect-infra.js` | Identifies runtime infrastructure needs, writes `infra-requirements.yaml` |
| `manifest-freeze.js` | Freezes manifest and generates wiki |
| `task-store.js` | File-based task store with atomic operations |
| `execute.js` | Main execution loop |
| `normalize-output.js` | Language-aware frontmatter, chat-salvage, idempotent |
| `fork-manifest.js` | Mints a fork for a BLOCKED task |
| `deliberate-fork.js` | Council deliberation → manifest patch + re-dispatch |
| `fork-amend.js` | Applies fork patch, unblocks originating task |
| `dashboard.js` | Build-state dashboard server |
| `dag.js` | DAG computation and topological sorting |
| `assemble.js` | Structural assembly check |
| `deploy-output.js` | Resolves the stable project identity and materializes staged output into the canonical project tree (idempotent merge, build provenance, conflict detection) |
| `project-resolve.js` | Resolve/create the stable project identity (root + structure profile + build history) so builds share one tree |
| `manifest-validate.js --gate 4` | Layout gate — every task `file_path` conforms to the framework structure profile |
| `verify-build.js` | Phase 3 — typecheck/build/test, failure attribution |
| `producer-symbol-check.js` | Per-task (pre-validator) — deterministic check that each emitted file exports its declared contract symbols; drives `retry-update` |
| `edit-ops.js` | Constrained deterministic editor (rename-symbol/add-export/replace-line) — the only edit path for `retry-update`; reused by `tsc-suggest-fix` |
| `tsc-suggest-fix.js` | Phase 3 — applies TypeScript's own `Did you mean …?` suggestions deterministically (TS2613/2551/2552/2769/2322), before LLM triage |
| `triage-failures.js` | Phase 3 — `triage`-tier verdict, `patch`-tier quick_fix or fork routing |
| `emulator-start.js` | **Phase 4** — starts/stops Firebase, Docker Postgres/Redis/MySQL, Supabase |
| `app-serve.js` | **Phase 4** — framework detection, app start, readiness polling |
| `e2e-generate.js` | **Phase 4** — Playwright suite generation from TESTING doc + contracts |
| `e2e-run.js` | **Phase 4** — Playwright execution, screenshot capture, e2e-report.yaml |
| `e2e-chase.js` | **Phase 4** — tiered failure-chase loop (tier1 → tier2 → council → report) |
| `build-report.js` | **Phase 4** — final Markdown build report with screenshots |
