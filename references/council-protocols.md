# Council Deliberation Protocols

## How Councils Run

Each council is implemented as a series of sub-agent API calls. The orchestrator (Claude in the main session) manages the flow but never ingests the full deliberation content — only status lines.

### Single-Call Council (Recommended for Speed)

For most councils, run the deliberation as a single API call with a multi-persona system prompt. The sub-agent simulates all council members internally and produces the synthesized output directly.

```
System prompt structure:
1. Council composition (who is at the table)
2. Input corpus summary
3. Deliberation protocol (propose → critique → synthesize)
4. Output format specification

The sub-agent runs the full deliberation internally and outputs only the synthesized artifact.
```

This is more token-efficient than multi-call councils and eliminates inter-call coordination.

### Multi-Call Council (For Complex Decisions)

When a single call produces low-quality synthesis (typically at the C-Suite tier where decisions have the highest impact), split into sequential calls:

1. **Proposal calls** — One call per proposer persona. Each writes to a separate file.
2. **Critic call** — Receives all proposal file paths, reads them, produces critique.
3. **Rebuttal call** — Proposers receive critique, produce amendments (one round only).
4. **Synthesis call** — Receives all proposals, critique, and rebuttals. Produces final artifact.

Each call returns `ok` (wrote output to file) or `err:[description]`.

## C-Suite Council Protocol

**Model:** claude-opus-4-6
**Participants:** Visionary, Product Strategist, Quality Strategist, Critic, Synthesizer
**Input:** corpus-index.yaml + full input documents
**Output:** epics, architecture, DAG, functional area map

### Prompt Construction

Build the system prompt by concatenating:
1. The C-Suite council description (from this doc)
2. All persona definitions for council members (from personas.md)
3. The output format specification (from manifest-schema.md)

Build the user message by concatenating:
1. The corpus-index.yaml content
2. Each input document's full text (PRD, specs, design docs, test docs)
3. Instruction: "Run the C-Suite council deliberation and produce the synthesized output."

### Call Pattern

```bash
node scripts/subagent.js \
  --persona csuite \
  --model claude-opus-4-6 \
  --input input/corpus-index.yaml \
  --input-docs input/ \
  --output-dir manifest/epics/ \
  --phase planning
```

The subagent.js script:
1. Reads the persona definitions and builds the system prompt
2. Reads all input files and builds the user message
3. Calls the API with the assembled messages
4. Parses the YAML response
5. Writes individual files (one per epic, plus architecture.yaml, dag-skeleton.yaml, functional-areas.yaml)
6. Returns "ok" or "err:[description]"

## Director Council Protocol

**Model:** claude-sonnet-4-6
**Participants:** Domain Lead, Integration Architect, Critic, Synthesizer
**Input:** Epics for this functional area + architecture document
**Output:** Task groups, contracts, ownership map

### One Council Per Functional Area

The orchestrator reads `manifest/functional-areas.yaml` and spawns one Director council per area. These run in parallel (all are independent reads of the same epic set, producing outputs in their own namespace).

### Prompt Construction

System prompt:
1. Director council description
2. Director + Integration Architect persona definitions
3. Critic + Synthesizer persona definitions
4. The functional area assignment for this specific council
5. Output format specification

User message:
1. All epic YAML files relevant to this functional area
2. architecture.yaml
3. Instruction: "Run the Director council for the {AREA} functional area."

### Cross-Area Contract Awareness

Each Director council independently drafts contracts for its boundaries. The reconciliation step (Section 11 of the spec) catches conflicts after all Director councils complete. Directors should draft contracts optimistically — it's cheaper to reconcile than to under-specify.

### Contracts are binding — produce a structured `surface:` block

When a Director council defines a contract, the YAML MUST include a structured `surface:` block that enumerates every symbol the contract exposes (see `references/manifest-schema.md` "Interface Contract"). Each entry pins one method, endpoint, type, event, or constant by exact name and signature.

- `definition:` (freeform IDL prose) is for humans and downstream context. It is not authoritative.
- `surface:` is authoritative. Gate 2 rejects any contract missing `surface:` or with `definition:`↔`surface:` disagreement.
- Engineers downstream MUST only reference symbols that appear in `surface:`. If a Director feels the surface is incomplete, expand it before freezing — do not rely on consumers improvising. **A contract that fails to constrain consumer calls is the council's failure, not the consumer's.**

When in doubt, over-enumerate. A symbol present in `surface:` but unused by any consumer is a `noise` advisory (non-blocking). A symbol absent from `surface:` but referenced by a consumer is a hard Gate 3 failure.

### Critic responsibilities — surface completeness (M3.5)

Before the Synthesizer freezes any Director output, the Critic performs the surface-completeness check on
every drafted contract (a **hard reject**, not an advisory):

1. Enumerate every operation/method/endpoint the contract's `definition:` prose describes.
2. Verify each appears in the structured `surface:`. `definition:` naming `JobStore.list_jobs()` while
   `surface:` lists only `list` is a malformed contract — the Synthesizer fixes it before freezing.
3. Verify every `surface:` entry carries a complete signature — `signature: TBD` / `signature: "..."` is invalid.
4. Verify every cross-area boundary is fully covered. A missing surface entry forces Engineer-tier
   improvisation downstream; under-specification at Director tier is the root cause of the
   214-promotion / 63-task-escalation failure mode the hardened prompts exist to prevent.

## Engineer Council Protocol

**Model:** claude-sonnet-4-6
**Participants:** Senior Engineer (x2), Contracts Engineer, Critic, Synthesizer
**Input:** Task groups for this (area, epic) pair + relevant contracts
**Output:** Atomic tasks, file tree, contract cross-references

### One Council Per (Functional Area × Epic)

The orchestrator computes the cross-product of functional areas and epics (filtering to only pairs that have task groups) and spawns one Engineer council per pair. These run in parallel.

### Prompt Construction

System prompt:
1. Engineer council description
2. Senior Engineer + Contracts Engineer persona definitions
3. Critic + Synthesizer persona definitions
4. The (area, epic) assignment
5. Output format specification

User message:
1. Task group YAML files for this (area, epic) pair
2. All contracts relevant to this area (produced or consumed)
3. The file tree so far (to avoid path collisions)
4. Instruction: "Run the Engineer council for {AREA} in {EPIC}."

### Atomic Task Granularity

A task is atomic if:
- It produces exactly one file
- It can be implemented by a Haiku model in a single API call
- It has a clear, unambiguous specification
- Its token budget is under 8,000 output tokens

If a proposed task violates any of these, the Critic should flag it for splitting.

### Enumerate consumed and produced contract symbols by name

Every task that references a contract MUST enumerate the specific symbols it touches:

```yaml
contracts_consumed:
  - contract_id: "CONTRACT-DB-02"
    invokes: ["JobStore.list", "JobStore.get", "JobStore.update"]
contracts_produced:
  - contract_id: "CONTRACT-API-USER-CREATE"
    implements: ["POST /users", "CreateUserRequest", "UserResponse"]
```

The Engineer council MUST:

1. Read the contract's `surface:` block. Symbol names in `invokes:` / `implements:` are exact substrings of `surface[].name` — no aliases.
2. Reject any proposed task that uses a method name not in the contract's surface (the Critic persona is responsible for this gate at council time).
3. For a producer task, the union of `implements:` across all producer tasks for a given contract MUST equal that contract's full surface — no symbol is left without a producer.
4. For a consumer task, every entry in `invokes:` MUST appear in some other task's `implements:` for the same contract — Gate 3 enforces this symmetry programmatically.

**The Contracts Engineer persona's primary job is enforcing this enumeration.** If a Senior Engineer proposes a task that calls `db.list_jobs()` when CONTRACT-DB-02 only defines `JobStore.list()`, the Contracts Engineer flags it. The Synthesizer either renames the call to match the contract, escalates the task with `escalation_type: CONTRACT_CONFLICT`, or sends the contract back to Director-tier for expansion. Improvisation is a council failure.

## Validation Gates

Gates are programmatic — no LLM calls. They read YAML files and check structural properties.

### Gate 1 (Post C-Suite)

Read all epic files and the PRD. Check:
- [ ] Every PRD requirement ID appears in at least one epic's `prd_refs`
- [ ] Every epic has non-empty `acceptance_criteria`
- [ ] The epic DAG (from `dag-skeleton.yaml`) has no cycles
- [ ] Every epic has at least one `functional_area`
- [ ] No requirement maps to more than 3 epics

### Gate 2 (Post Director)

Read all task group and contract files. Check:
- [ ] Every epic has at least one task group per assigned area
- [ ] Every task group that references a contract — that contract file exists
- [ ] No namespace in ownership.yaml has multiple owners
- [ ] Contract definitions are non-empty and contain recognizable IDL syntax
- [ ] Merging task group `depends_on` with epic DAG produces no cycles

### Gate 3 (Post Engineer)

Read all task files and the file tree. Check:
- [ ] Every task group has at least one task
- [ ] No two tasks have the same `file_path`
- [ ] Every `contracts_consumed` and `contracts_produced` reference exists
- [ ] Every contract is in at least one task's `contracts_produced` AND one task's `contracts_consumed`
- [ ] The full task DAG is acyclic (topological sort succeeds)
- [ ] Sum of `token_budget` across all tasks is within resource limits

## Contract Reconciliation Protocol

After all Director councils complete and Gate 2 passes, run reconciliation:

1. **Scan** — Programmatic: find contracts with overlapping type names or field names across areas
2. **Classify** — Programmatic: identical (dedup), compatible (merge), conflicting (arbitrate)
3. **Dedup** — Programmatic: assign canonical owner, create import references
4. **Merge** — Sub-agent call (Sonnet Director): produce superset contract, validate no new obligations
5. **Arbitrate** — Sub-agent call (Sonnet Director multi-persona): resolve conflicts via deliberation
6. **Patch** — Programmatic: update manifest with resolved contracts, re-run Gate 2

Each sub-agent call returns `ok` or `err:[unresolved conflict description]`.

## Execution Sub-Agent Patterns

### Worker Dispatch

```bash
node scripts/subagent.js \
  --persona coder \
  --model claude-haiku-4-5-20251001 \
  --task-file manifest/tasks/TASK-API-0042.yaml \
  --contracts-dir manifest/contracts/ \
  --output-file output/src/api/users/createUser.ts \
  --phase execution
```

The worker receives: task spec + all consumed contracts + file path.
The worker writes: the implementation file with frontmatter + synopsis.
The worker returns: "ok" or "err:[type]:[description]"

### Validation Dispatch

```bash
# Schema validation (Haiku)
node scripts/subagent.js \
  --persona schema-validator \
  --model claude-haiku-4-5-20251001 \
  --validate-file output/src/api/users/createUser.ts \
  --task-file manifest/tasks/TASK-API-0042.yaml \
  --contracts-dir manifest/contracts/ \
  --phase validation

# Integration validation (Sonnet, critical junctions only)
node scripts/subagent.js \
  --persona integration-validator \
  --model claude-sonnet-4-6 \
  --validate-file output/src/api/users/createUser.ts \
  --task-file manifest/tasks/TASK-API-0042.yaml \
  --dependent-tasks manifest/tasks/TASK-UI-0023.yaml manifest/tasks/TASK-UI-0024.yaml \
  --contracts-dir manifest/contracts/ \
  --phase validation
```

### Escalation Dispatch

```bash
node scripts/subagent.js \
  --persona escalation-handler \
  --model claude-sonnet-4-6 \
  --escalation-envelope store/escalations/TASK-API-0042.yaml \
  --manifest-dir manifest/ \
  --phase escalation
```

The escalation handler reads the envelope, makes a decision, and optionally produces manifest patches. Returns "ok" or "err:escalate_to_director" (if the issue is too severe).
