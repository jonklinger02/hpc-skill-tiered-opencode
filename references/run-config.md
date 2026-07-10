# Run Configuration Reference

`run-config.yaml` controls autonomous, continuous operation (M4) and recovery iteration caps (M5).
It is read by `execute.js` (`--run-config <file>`). CLI flags override file values; file values override
built-in defaults. **All autonomy behavior is off unless `auto_continue: true` (or `--auto-continue`)** —
without it, `execute.js` behaves exactly as in supervised mode (no heartbeat, no auto-continue, no
watchdog-triggered recovery).

> **Model selection lives elsewhere.** `run-config.yaml` does not control which models run. That is
> governed by the central tier registry `models.yaml` at the skill root (resolved via
> `scripts/lib/models.js`): every `--model`/`--worker-model`/`--judge-model`/… flag accepts a tier name,
> a role name, or a literal id. To re-point the build's models, edit `models.yaml`, not this file.

```yaml
run_config:
  auto_continue: true          # chain runs without a human between them (default: false)
  cooloff_minutes: 1           # wait between auto-continued runs
  abort_threshold: 0.70        # worker-err rate above this in a run segment → RUN-ABORTED.md + halt
  max_run_count: 50            # hard cap on consecutive auto-continued runs (sanity)
  heartbeat_sec: 30            # status line cadence (observability only)
  watchdog_stall_min: 15       # no task transition within this window (workers active) → recovery trigger
  notification_webhook: null   # optional; POST halt notifications here (also --notification-webhook)

  # M5 — autonomous recovery (consumed by the recovery ladder / budget-tracker.js):
  recovery_iteration_cap_override: null   # null = infer from manifest size/complexity (absolute cap 15)
```

## Field semantics

| Field | Meaning |
|---|---|
| `auto_continue` | Master switch. When true, `execute.js` auto-runs `deliberate-fork` on pending forks and re-enters the loop instead of stopping for a human. |
| `cooloff_minutes` | Sleep between auto-continued runs (the only intentional inter-run gap). |
| `abort_threshold` | Run-segment worker-error rate (errors ÷ dispatches). Above it → systemic failure → `RUN-ABORTED.md` + notify + halt. 0.70 is lenient: a messy-but-progressing run continues; only "every worker crashing" trips it. |
| `max_run_count` | Consecutive-run ceiling; halts even if conditions allow continuing. |
| `heartbeat_sec` | Cadence of the `phase=execute run=N tasks=... last_transition=Ns_ago` observability line. |
| `watchdog_stall_min` | Build-level stall window. No task transition within it (workers active) → dump `wiki/stall-diagnostic-<ts>.yaml` and trigger recovery. (Council deliberations use a 30-min window.) |
| `notification_webhook` | If set, halt artifacts are POSTed here in addition to the `[HPC-HALT]` commit. |
| `recovery_iteration_cap_override` | M5: `null` infers the cap from manifest size + complexity; a number forces it. Absolute cap is 15. |

## Halt states (the only outbound-notification triggers — M4 §4.4)

`ACCEPTANCE-REPORT.md` (pass/fail), `SPEC-DEFECT.md`, `SANITY-CAP-HIT.md`, `RUN-ABORTED.md`. Each is
committed to the workspace repo with an `[HPC-HALT]` prefix (via `notify-halt.js`) and POSTed to the
webhook if configured. Phase transitions, council deliberations, and worker crashes write to the audit
log only — they never notify.
