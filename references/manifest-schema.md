# Manifest Schema Reference

All manifest artifacts are YAML files. This document defines the canonical schemas.

## Manifest Root — `manifest.yaml`

```yaml
manifest_id: uuid
version: "1.0.0"
created_at: ISO-8601
updated_at: ISO-8601
status: PLANNING | VALIDATING | APPROVED | EXECUTING | COMPLETE
input_corpus:
  prd: path
  specs: [paths]
  design_docs: [paths]
  test_docs: [paths]
epic_count: integer
task_group_count: integer
task_count: integer
contract_count: integer

# Machine-readable record of the build's languages and roles. Populated by the
# C-Suite council and seeded into manifest.yaml early (pre-freeze) by
# split-council-output.js so Gate 1 can read it. Glue-epic detection,
# boot_smoke template selection, module-path emission, and import-graph stack
# support all consume this. Gate 1 (--completeness) rejects a missing/empty
# tech_stack.
tech_stack:
  - language: python          # python | typescript | javascript | go | rust | ...
    role: control_plane       # control_plane | api_server | web_ui | ssr_app | cli | lib | worker
    package_manager: pip      # pip | npm | pnpm | yarn | cargo | go
    test_runner: pytest
  - language: typescript
    role: api_server
    framework: express
    package_manager: npm
  - language: typescript
    role: web_ui
    framework: react
    bundler: vite
    package_manager: npm
    # package: web            # OPTIONAL — only in a monorepo: names the workspace
    #                         # package this entry belongs to. Two or more distinct
    #                         # `package:` values make the project resolve to the
    #                         # `monorepo` structure profile (apps/* + packages/*).

# OPTIONAL — pin the framework structure profile instead of inferring it from
# tech_stack + infra. One of: nextjs-app | nextjs-pages | vite-react | vue |
# express | fastify | python-src | go | rust | monorepo | generic. The profile
# decides the framework-standard file layout (where routes/components/servers/
# tests live); module-path-emit records it and Gate 4 enforces it. See
# references/structure-profiles/.
# structure_profile: nextjs-app
```

### Glue epic — `epics/E-GLUE-000.yaml`

When `tech_stack` declares any of `api_server`, `web_ui`, or `ssr_app`, the C-Suite MUST emit an epic
with `epic_id: "E-GLUE-000"` that owns the cross-cutting boot layer (config, entrypoints, package layout)
no feature epic owns. It is a normal Epic file; the only special rule is that Gate 1 (`--completeness`)
fails the manifest if it is missing or has no `functional_areas` when the stack requires it. Per-stack
boot ownership:

| Stack role | Files owned by E-GLUE-000 |
|---|---|
| `web_ui` (Vite + React) | `vite.config.ts`, `tsconfig.json`, `index.html`, `src/ui/main.tsx`, `src/ui/App.tsx` |
| `web_ui` (Next.js) | `next.config.js`, `tsconfig.json`, `src/app/layout.tsx`, `src/app/page.tsx` |
| `api_server` (Express) | `src/server/app.js`, `src/server/middleware/`, entrypoint script |
| `api_server` (Fastify) | `src/server/server.js`, plugin registration, entrypoint |
| `control_plane` (Python) | `__init__.py` files, package layout, entrypoint module |

## Epic — `epics/EPIC-NNN.yaml`

```yaml
epic_id: "EPIC-001"
name: string
description: string (detailed scope and purpose)
acceptance_criteria:
  - string (measurable criteria)
prd_refs:
  - string (PRD requirement IDs)
functional_areas:
  - UI | API | LIB | DB | INFRA | TEST
priority: integer (1 = highest)
depends_on:
  - epic_id
status: PLANNED | IN_PROGRESS | COMPLETE | BLOCKED
version: integer (OCC version counter, starts at 1)
```

## Task Group — `task-groups/GRP-{AREA}-NNN.yaml`

```yaml
group_id: "GRP-API-001"
epic_id: "EPIC-001"
functional_area: API
name: string
description: string
depends_on:
  - group_id (can cross functional areas)
contracts_produced:
  - contract_id
contracts_consumed:
  - contract_id
owner_namespace: "/api/users/*"
status: PLANNED | IN_PROGRESS | COMPLETE
version: integer
```

## Atomic Task — `tasks/TASK-{AREA}-NNNN.yaml`

```yaml
task_id: "TASK-API-0042"
group_id: "GRP-API-001"
epic_id: "EPIC-001"
name: string (concise)
description: string (full implementation specification)
file_path: "src/api/users/createUser.ts"
artifact_type: ENDPOINT | FUNCTION | CLASS | COMPONENT | SCHEMA | CONFIG | TEST | DOC
signature: "export async function createUser(req: CreateUserRequest): Promise<UserResponse>"

# Contracts are BINDING. Each entry enumerates the exact symbols this task
# invokes (consumes) or provides (produces). Symbol names MUST match the
# contract's `surface:` block exactly — no aliases, no improvisation.
contracts_consumed:
  - contract_id: "CONTRACT-USER-001"
    invokes: ["UserStore.get", "UserStore.create"]   # exact method/symbol names from contract.surface
contracts_produced:
  - contract_id: "CONTRACT-API-USER-CREATE"
    implements: ["POST /users", "CreateUserRequest", "UserResponse"]

depends_on:
  - task_id
token_budget: integer (estimated tokens for worker)
escalation_criteria:
  - string (conditions for escalation)
status: PLANNED | LOCKED | IN_PROGRESS | REVIEW | COMPLETE | ESCALATED | BLOCKED | INVALIDATED
assigned_worker: string | null
version: integer
retry_count: integer (starts at 0)
max_retries: 3
```

## Interface Contract — `contracts/CONTRACT-{DOMAIN}-NNN.yaml`

```yaml
contract_id: "CONTRACT-USER-001"
name: "UserResponse"
contract_type: OPENAPI | TYPESCRIPT | SQL_DDL | GRAPHQL | PROTOBUF | JSON_SCHEMA

# `surface:` is the BINDING enumeration of every symbol this contract exposes.
# Producers must implement every entry; consumers may only reference entries
# that appear here. Names are case-sensitive and exact.
#
# `definition:` below is the freeform IDL (for human reading and validator
# context); `surface:` is what gates and validators enforce. The two MUST
# agree — if `definition:` describes a method not in `surface:`, the contract
# is malformed and Gate 2 rejects it.
surface:
  - kind: METHOD          # METHOD | ENDPOINT | TYPE | EVENT | CONST
    name: "UserStore.get"
    signature: "get(id: UUID) -> User | null"
    async: false
  - kind: METHOD
    name: "UserStore.list"
    signature: "list() -> User[]"
    async: false
  - kind: TYPE
    name: "User"
    fields: ["id: UUID", "name: string", "created_at: ISO8601"]
  - kind: ENDPOINT
    name: "POST /users"
    request: "CreateUserRequest"
    response: "UserResponse"

definition: |
  (the contract body in the appropriate IDL — inline YAML string. MUST be a
  faithful expansion of `surface:`. If they disagree, `surface:` wins and
  the contract is flagged for reconciliation.)
produced_by:
  - task_id
consumed_by:
  - task_id
owner_area: API
version: integer
reconciled: boolean
frozen: boolean
```

### Binding rule

A contract is *binding* on both sides of every boundary it crosses:

- **Producer side:** the task that lists `contracts_produced: [{id: X, implements: [a,b,c]}]` MUST emit code that defines exactly those symbols with the signatures in `X.surface[]`. A producer that ships `list_jobs()` when the surface says `list()` is a contract violation — caught by the per-task schema validator.
- **Consumer side:** the task that lists `contracts_consumed: [{id: X, invokes: [a,b]}]` MUST only reference symbols that appear in `X.surface[]`. A consumer that calls `db.list_jobs()` when `X.surface` only defines `list()` is a contract violation — caught by the per-task integration validator and re-checked at Gate 3.
- **Symmetry rule:** every symbol in `consumer.invokes` MUST appear in some producer's `implements` for the same contract. Asymmetric references are a reconciliation failure — Gate 3 blocks the manifest.

If a worker finds the surface insufficient, escalate via fork (`escalation_type: CONTRACT_CONFLICT`). Do not improvise method names — improvisation is what produces the integration drift that survives to Phase 4.

### INTERFACE_CONTRACT flavor (M2 §2.3)

A contract may set `contract_type: INTERFACE_CONTRACT` with a `flavor` field that pins the kind of
interface, so validators check return shapes / endpoint shapes — not just method names. This generalizes
the React-hook return-shape contract to other interface kinds.

```yaml
contract_id: "INTERFACE-USE-AUDIT-LOG"
contract_type: "INTERFACE_CONTRACT"
flavor: "react-hook"          # see supported flavors below
surface:
  - kind: HOOK_RETURN
    name: "useAuditLog"
    fields:
      - "records: AuditRecord[]"
      - "nextPageToken: string | null"
      - "isLoading: boolean"
      - "error: Error | null"
```

**Supported flavors:** `react-hook` (hook return shape) · `vue-composable` · `svelte-store` ·
`python-protocol` (`typing.Protocol`) · `go-interface` · `external-api` (a third-party HTTP API the build
*consumes*).

**`external-api`** is the underrated drift source — a worker writing against "the Stripe API" can
hallucinate endpoint paths or response fields. Pin them so workers cannot improvise:

```yaml
contract_id: "EXT-STRIPE-CHARGES"
contract_type: "INTERFACE_CONTRACT"
flavor: "external-api"
base_url: "https://api.stripe.com/v1"
auth: "bearer"
surface:
  - kind: ENDPOINT
    name: "POST /charges"
    request_shape: { amount: number, currency: string, source: string }
    response_shape: { id: string, status: string, amount: number }
```

## Build Commands — `manifest/build-commands.yaml`

Drives Phase 3 (`verify-build.js`). `boot_smoke` (M2 §2.1) is the phase that proves the product actually
*runs*, not just compiles — mandatory whenever `tech_stack` declares `api_server`, `web_ui`, `ssr_app`,
or `cli`. A required phase that is skipped (null command) counts as a build failure (`all_green: false`),
and Gate 1 (`--completeness`) rejects a runnable stack with no `boot_smoke`.

```yaml
typecheck: "npx tsc --noEmit"
build: "npx vite build"
test: "npm test --silent"
boot_smoke: "npx vite build && npx vite preview --port $PORT & sleep 3 && curl --retry 5 --fail http://localhost:$PORT/"
# Phases that MUST run green. A required phase that is skipped is a failure.
# boot_smoke is auto-required when tech_stack declares a runnable surface.
required_phases: [typecheck, build, boot_smoke]
```

**Per-stack boot_smoke templates:**

```bash
# Vite + React web UI
npm ci && npx vite build && npx vite preview --port $PORT & PID=$!; sleep 3
curl --retry 5 --retry-delay 2 --fail http://localhost:$PORT/ ; kill $PID

# Express API server
npm ci && node src/server/app.js & PID=$!; sleep 3
curl --retry 5 --retry-delay 2 --fail http://localhost:$PORT/health ; kill $PID

# Python control plane (CLI invocation)
pip install -e . && python -m control_plane --version

# Library smoke test
pip install -e . && python -c "import <module>; <smoke_instantiation>"
```

## DAG Edge — stored in `manifest.yaml` or `dag.yaml`

```yaml
dag:
  - source_id: "TASK-API-0001"
    target_id: "TASK-API-0002"
    edge_type: HARD | SOFT | CONTRACT
    contract_id: "CONTRACT-USER-001" | null
```

## Deliberation Record — `deliberations/SESSION-{TIER}-NNN.yaml`

```yaml
session_id: "SESSION-CSUITE-001"
tier: CSUITE | DIRECTOR | ENGINEER
functional_area: null | string
timestamp: ISO-8601
participants:
  - persona: Visionary
    model: csuite_council   # tier/role token — resolves to a model id via models.yaml
proposals:
  - author_persona: string
    content_path: path (to the proposal YAML)
critic_analysis:
  content_path: path
synthesis:
  content_path: path
  decisions:
    - decision: string
      alternatives: [string]
      rationale: string
      dissent: string | null
```

The split council output writes the decisions array to
`manifest/deliberations/{tier}-decisions-log.yaml` under a top-level `decisions_log:` key.

### Deferral disposition (binding under `--completeness`)

Every `decisions_log` entry that records a deferral MUST set `status: deferred` AND carry a
`deferral_disposition`. "Documented and deferred" is not the same as "scheduled for resolution" — under
autonomy a deferral with no disposition is illegal and Gate 1 blocks the freeze.

```yaml
decisions_log:
  - decision: "Defer multi-tenant org isolation"
    status: deferred
    rationale: "Out of scope for the capability-routing MVP"
    # exactly one of:
    deferral_disposition:
      generated_task: "TASK-LIB-0042"   # must exist and block the deferring epic's start
    # or:
    # deferral_disposition:
    #   waiver: "No current-build consumer; revisit in E-MULTI-TENANT-FOUNDATION"
    #   countersigned_by: ["Synthesizer", "Critic"]   # Synthesizer + ≥1 dissenter
```

## Deferred Scope — `input/deferred-scope.yaml`

Written by `scripts/corpus-filter.js`. Captures what the C-Suite intentionally left for a future build,
as a first-class artifact rather than letting the deferral disappear and reappear as council disagreement.
Gate 1 (`--completeness`, §1.8) checks that each entry's `depends_on_current_build` is satisfied by some
current-build epic output, and that the deferred capability does NOT appear in any current-build acceptance
criterion (which would mean it was wrongly classified as deferred).

```yaml
deferred_scope:
  - id: "DEFERRED-001"
    corpus_sections:
      - "Vektor-PRD.md §4.3 — Multi-tenant org management"
    summary: |
      Multi-tenant organization isolation with per-org capability graphs.
    rationale: "Out of scope for capability-shaped routing MVP."
    depends_on_current_build:
      - "Capability classifier API"
      - "Audit log writer"
    suggested_future_epic: "E-MULTI-TENANT-FOUNDATION"
    rough_task_estimate: 40
```

## Module Paths — `manifest/module-paths.yaml`

Written by `scripts/module-path-emit.js` after the Director phase and before the Engineer phase. Engineer
councils and workers consult it before deciding ANY import path, so workers stop independently inventing
module paths (the source of integration shims). A task that needs a shared module lists
`MODULE-PATHS-MANIFEST` in its `contracts_consumed`.

```yaml
module_paths:
  logical_name_to_path:
    "LoadingSkeleton": "src/ui/components/LoadingSkeleton.tsx"
    "useAuditLog": "src/ui/hooks/useAuditLog.ts"
  alias_anchors:
    "@/components": "src/ui/components"
    "@/hooks": "src/ui/hooks"
    "@/api": "src/ui/api"
  conventions:
    react_component_location: "src/ui/components"
    react_hook_location: "src/ui/hooks"
```

## Acceptance Criteria — `manifest/acceptance-criteria.yaml`

Written by `scripts/extract-acceptance.js`. Every acceptance criterion is pulled from the PRD/scope-corpus
and classified `observable` (directly judgeable by the M6 acceptance harness) or `requires-decomposition`
(needs explicit sub-criteria the judge checks individually). Gate 1 (`--completeness`, §1.9) requires this
file to be populated.

```yaml
acceptance_criteria:
  - id: "AC-001"
    source: "REQ-AUTO-014"
    text: "The dashboard displays current canary rollout percentage updated every 5 seconds"
    classification: "observable"
    judgeable_directly: true
    requires_subcriteria: false
  - id: "AC-002"
    source: "REQ-AUTO-021"
    text: "MVP supports user login"
    classification: "requires-decomposition"
    judgeable_directly: false
    requires_subcriteria: true
    subcriteria:
      - "POST /auth/login returns 200 for valid credentials"
      - "POST /auth/login returns 401 for invalid credentials"
      - "Authenticated session persists across page reloads"
```

## Task Store State — `store/state.json`

```json
{
  "initialized_at": "ISO-8601",
  "last_updated": "ISO-8601",
  "tasks": {
    "TASK-API-0001": {
      "status": "COMPLETE",
      "version": 3,
      "locked_by": null,
      "locked_at": null,
      "started_at": "ISO-8601",
      "completed_at": "ISO-8601",
      "retry_count": 0,
      "validation_result": "ok",
      "escalation_history": []
    }
  },
  "dag_edges": [],
  "batch_history": [
    {
      "batch_id": 1,
      "dispatched_at": "ISO-8601",
      "task_ids": [],
      "results": {}
    }
  ]
}
```

## Wiki File Index — `wiki/file-index.yaml`

```yaml
files:
  - path: "src/api/users/createUser.ts"
    task_id: "TASK-API-0042"
    contracts: ["CONTRACT-USER-001"]
    status: COMPLETE
    synopsis_hash: string
```

## Wiki Contract Index — `wiki/contract-index.yaml`

```yaml
contracts:
  - contract_id: "CONTRACT-USER-001"
    implementing_files:
      - path: "src/api/users/createUser.ts"
        task_id: "TASK-API-0042"
    consuming_files:
      - path: "src/ui/components/UserForm.tsx"
        task_id: "TASK-UI-0023"
```

## Progress Dashboard — `wiki/progress.yaml`

```yaml
overall:
  total_tasks: integer
  complete: integer
  in_progress: integer
  planned: integer
  escalated: integer
  blocked: integer
  percent_complete: float
by_epic:
  EPIC-001:
    total: integer
    complete: integer
by_area:
  API:
    total: integer
    complete: integer
last_updated: ISO-8601
```

## Worker Crash Capture — `wiki/worker-crashes/` (M3 §3.2)

When a worker subprocess exits non-zero with no structured `ok`/`err:` output, `subagent.js` writes
`wiki/worker-crashes/<task_id>-<epoch_ms>.log` (EXIT_CODE, CRASH_REASON, stderr, stdout) and emits an
`err:exec:<crash_reason>:...` status line. The orchestrator's `worker-err` event carries `crash_reason`.

`crash_reason` ∈ `structured_error | empty_output | timeout | oom | rate_limit`:

| crash_reason | detected from |
|---|---|
| `timeout` | SIGTERM/SIGKILL/"timed out" in output, or the runAsync timeout fired |
| `oom` | "out of memory" / "OOM" / "allocation failed" / "JS heap" |
| `rate_limit` | "rate limit" / 429 / "quota" / "overloaded" |
| `empty_output` | no stdout and no stderr |
| `structured_error` | non-zero exit with some output but no `ok`/`err:` line |

## Escalation Envelope — passed to escalation handler

```yaml
task_id: string
worker_id: string
escalation_type: AMBIGUITY | CONTRACT_CONFLICT | SCOPE_QUESTION | DEPENDENCY_MISSING | ERROR
attempted_action: string
ambiguity_description: string
options:
  - string (2-3 options the worker identified)
relevant_contracts:
  - contract_id
context_snippet: string (minimal context)
```

## Frontmatter Template — top of every generated file

```yaml
---
task_id: "TASK-API-0042"
group_id: "GRP-API-001"
epic_id: "EPIC-001"
file_path: "src/api/users/createUser.ts"
artifact_type: ENDPOINT
contracts_produced:
  - "CONTRACT-USER-001"
contracts_consumed:
  - "CONTRACT-AUTH-001"
generated_by: "claude-haiku-4-5-20251001"
generated_at: "2026-04-30T12:00:00Z"
checksum: "sha256:abc123..."
---
```

## Synopsis Template — immediately after frontmatter

```
# SYNOPSIS
# L12-L18   : Import declarations
# L20-L35   : Request validation schema (CONTRACT-USER-001)
# L37-L62   : createUser handler - POST /api/users
# L64-L89   : getUserById handler - GET /api/users/:id
# L91-L105  : Error handling middleware
# L107-L112 : Route registration and export
```

Format: `# L{start}-L{end} : {description} ({contract_id if applicable})`
