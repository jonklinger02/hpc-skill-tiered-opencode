# Acceptance Protocol (Phase 5 — M6)

Phase 5 runs after Phase 4 (E2E) passes. It validates the built product against PRD **intent**, not just
that it compiles and runs. Pass is pass; fail is fail; there is no "passes in spirit". This is what makes
the Vektor "shipped with stub bodies" failure mode structurally impossible: the judge checks the *running*
product, and a stub that returns a placeholder or raises `not yet initialized` cannot pass a runtime
criterion.

## Inputs
- `manifest/acceptance-criteria.yaml` (produced in M1 by `extract-acceptance.js`) — each criterion is
  pre-classified `observable` or `requires-decomposition`.
- The running application URL (from Phase 4).
- The generated codebase + the app logs.

## Per-criterion dispatch
`acceptance-run.js` spawns one **Opus** judge per criterion (locked decision Q19). The judge has read-only
tool access: `Bash` (for `curl`, `playwright`, log reads), `Read` (generated code). It may write only
under `/tmp`. The skill already runs in a sandbox; the system prompt reinforces read-only.

**System prompt (fixed):**
> You are a strict acceptance judge. Your verdict is pass or fail. No middle ground. Stubs that raise
> NotImplementedError fail. Functions that return placeholder values fail. The criterion is satisfied only
> if the running product observably demonstrates it. You may NOT pass based on code inspection alone if the
> criterion describes runtime behavior. Emit exactly one final line: `pass:<evidence>` (with ≥1 curl
> response, log excerpt, or screenshot reference) or `fail:<specific cited reason>`.

## Observable vs requires-decomposition (locked decision Q20)

**Observable** — the judge determines whether the running app at the URL observably satisfies the
criterion. Pass requires a reproducible demonstration (curl response / log excerpt / screenshot). Fail when
the behavior can't be demonstrated, the implementation is a stub (raises, returns a hardcoded placeholder,
`pass` body on an action function), the behavior is partial, or it throws for the criterion's stated inputs.

**Requires-decomposition** — the judge evaluates each `subcriteria[]` entry individually; the parent passes
only if **all** sub-criteria pass. The failing sub-criteria are cited in the report.

## Aggregation + routing
All criteria must pass for `ACCEPTANCE-REPORT.md: PASS`. Any single fail makes the verdict FAIL and the
per-criterion judge evidence bundle (`wiki/acceptance/<id>.txt`) is routed back into M5 recovery (the
failure becomes the slice the recovery ladder re-plans). Recovery resolving the stub, or Tier 4 declaring
a spec defect, is the only way out — there is no path that ships a FAIL as done.

`ACCEPTANCE-REPORT.md: PASS` and `ACCEPTANCE-REPORT.md: FAIL` (after M5 exhausts) are both halt states:
they trigger `notify-halt.js` (commit `[HPC-HALT]` + webhook).

## Re-run scope (open question Q, best-read)
After M5 resolves a failure, re-run only the failed criteria initially; if a failure was global-impact (the
judge can flag it), re-run all. This avoids re-judging the whole suite for one fix.
