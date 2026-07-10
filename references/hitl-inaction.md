# Human-in-the-Loop-Inaction Protocol

A working pattern for long autonomous HPC runs where the operator may be AFK (sleeping, in a meeting, ran out for coffee) but the build needs to keep moving. The orchestrating Claude operates with **explicit ask + bounded wait + considered autonomous action**, not silent autopilot.

This is not a license to run faster or skip review. It is a license to *finish* when blocked, on the operator's behalf and in the operator's style, until they're back to ratify or correct.

---

## When to activate

Activate when the operator signals AFK during a long run. Signals are usually direct ("I may go to sleep", "I'll be out for a few hours") but can be implied ("let it run overnight", "you've got this"). When in doubt, ask once: "are you handing off to autonomous mode for this run?"

Stay activated until either:

- The operator explicitly resumes control ("I'm back, what's the state?"), OR
- The run reaches a clean terminal state (all tasks COMPLETE + clean assembly), OR
- The protocol's escalation criteria below fire and the operator has not responded after several cycles (in which case write down the state, stop, and wait — do not improvise across an ongoing impasse).

## The core loop

When the orchestrator detects a process flaw, structural failure, or judgment call that exceeds the routine pipeline machinery, it follows three steps:

### Step 1 — Ask

Write a single user-facing message that contains:

- **What was observed** — the failure mode in concrete terms (which task, which signature, what the error history says)
- **The hypothesis** — what's actually wrong (architectural gap? content quality? routing? validator blind spot?)
- **2–4 candidate fixes** — each one named, each with a one-line tradeoff. Order them from least invasive to most invasive.
- **The default if no response** — exactly which option the orchestrator will execute, with the reasoning. The operator should be able to do nothing and trust that the right thing happens.

Then schedule a **120-second wakeup** to fire the autonomous branch. Use `<<autonomous-loop-dynamic>>` so the loop continues afterward.

### Step 2 — Wait

If the operator responds within 120 seconds, follow their direction. Don't re-litigate the recommendation; they have context the orchestrator doesn't.

If they don't respond, the wakeup fires. Treat that as the timeout — proceed.

### Step 3 — Act autonomously

Three rules govern the autonomous action:

1. **Use subagents for investigation.** Investigate the root cause with an `Explore` or `general-purpose` subagent before patching. If the fix needs design (not just a search), use a `Plan` subagent. The subagent returns a summary; the main context stays lean. Right-size the model — Haiku for ops/diagnostics, Sonnet for investigation/planning, Opus only when reasoning is genuinely hard.
2. **Route the fix through the pipeline.** A task-level structural flaw is fixed by minting a fork and letting council deliberation handle it — *not* by hand-editing the manifest. A worker-output quality flaw is fixed by adding a normalization step or improving the prompt — *not* by hand-editing the artifact (unless validating that the underlying fix works on a representative sample). The same machinery that validates everything else must validate the fix.
3. **Patch root cause, never symptom.** No `--no-verify`, no destructive shortcuts, no manual store edits to push the project along. If the obstacle is a missing capability (e.g. no `ci_runner` worker), say so and either route around it via the council (re-spec the task to fit available capabilities) or escalate explicitly.

After the fix lands, **validate by running the actual pipeline step that originally failed**. If the failure pattern recurs, you've patched the wrong thing — go back to the ask.

## What requires the protocol

- **Architectural changes** — new state, new worker type, new transition, new persona, anything that touches the framework's mental model
- **Cross-script contract changes** — anything that requires editing >1 script in one go (the contract surface needs a real review)
- **Repeated structural failures** — the same fork blocks 2+ times after deliberation, or the same worker output quality issue recurs across many tasks (one is a glitch; many is a pattern)
- **Salvage decisions** — when the choice is "abandon X% of generated artifacts and re-run" vs "post-process to recover", the call has cost implications and the operator should weigh them
- **Trust-affecting actions** — anything that changes what the operator could rely on without checking (silent retries are fine; silent rewrites of prior outputs are not)

## What does NOT require the protocol

- Routine pipeline progress — keep the operator informed at sensible cadence (every 15–30 min during long deliberations) but don't ask permission to continue what they already authorized
- Council outcomes flowing through normal merge — that's the pipeline doing its job
- Worker promotion ladder (haiku → sonnet) firing on retry — the system is designed to do this
- Cosmetic decisions (logging format, exit message wording) — pick one and move on
- Reading files, running diagnostics, summarizing state — those are how the orchestrator stays honest, not actions that need approval

## Stall checks

Every ~30 minutes during a long autonomous run, perform a one-line stall check:

```bash
ps -ef | grep -E "<expected-process-pattern>" | grep -v grep | wc -l
```

If the count drops to 0 unexpectedly, investigate before assuming the run is done. Otherwise: tail the most recent log, compare timestamps, schedule the next wakeup. Use Haiku for these checks — they're cheap diagnostics.

Do not poll faster than every 5 minutes for a process that takes >10 minutes per unit of work. The Anthropic prompt cache TTL is 5 minutes; sleeping past 300 seconds means the next wake-up reads conversation context uncached. Either stay under 270 s (cache warm) or commit to ≥1200 s (one cache miss buys a much longer wait).

## Context discipline

- Aim to keep main context under 100k tokens
- Finish the current task before triggering `/compact`
- Don't read large logs or files into main context — pipe through `grep`/`head`/`tail` or have a subagent return just the answer
- For repeated stall checks, prefer single-line `ps`/`wc`/`tail` commands over reading full log files

## Do-not-do list

- **Do not** edit the task store directly to push the project along. Manual store writes are only allowed to validate a fix (e.g. proving a state transition works), never to bypass council deliberation or worker dispatch.
- **Do not** skip hooks (`--no-verify`, `--no-gpg-sign`, etc.) unless the operator has explicitly authorized it.
- **Do not** delete artifacts or workspace state during autonomous mode. If something looks wrong, investigate; if salvage is needed, it goes through the same propose-then-execute path as a structural fix.
- **Do not** stack ask-prompts on back-to-back turns. If the operator just answered a question, do not immediately ask another unless the second is genuinely independent. Batch related decisions when possible.
- **Do not** assume returning operator approval covers anything outside the explicit scope they approved.

## Audit trail

Every autonomous decision should leave an artifact the operator can review when they return:

- Fork `origin.yaml` files carry a `human_guidance` block when guidance was added under autonomous mode
- Salvage operations write to a log (e.g. a `salvage-log.txt` under the system temp dir)
- New scripts or framework patches carry an entry in the skill changelog
- The final run report (`wiki/RUN-REPORT.md`) summarizes every protocol activation, what was decided, and why

The operator's first action when they return should be reading the run report. If it's a long absence, send a "I'm back, here's the state" message that points them at it.

## Worked example — an autonomous build (2026-05-02)

The protocol fired twice during one long HPC build:

**Activation 1 — INFRA-007 ci_runner wall.** Three tasks BLOCKED with `worker_type: ci_runner` declared, but the architecture has no `ci_runner` worker. Council had already split the task once and re-blocked. Asked operator with 4 options (stub-document, hand-execute, add ci_runner worker, accept-incomplete) and a default of A. 120 s elapsed, no response. Acted on A: appended `human_guidance` to each fork's `origin.yaml` instructing the council to rewrite the task as a stub with a clear `# TODO: regenerate in CI` marker. Council respected the guidance precisely; rewritten tasks completed first try.

**Activation 2 — assembly chat-corruption.** `assemble.js` reported 137 issues across 156 files. Investigation showed 65 chat-corrupted (worker emitted prose around code blocks), 67 missing-frontmatter. Asked operator with 4 options (salvage / re-run / hybrid / patch the framework). 120 s elapsed; operator returned and chose A (salvage). Salvage script extracted code blocks, prepended frontmatter, brought issues to 0. Operator then asked for the framework fix that would prevent recurrence; that landed as `normalize-output.js` + a worker-prompt cleanup.

In both activations the protocol produced a real fix that the operator could ratify on return — no manual store edits, no abandoned work, no silent rewrites.
