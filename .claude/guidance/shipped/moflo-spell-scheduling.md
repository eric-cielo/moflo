# Spell Scheduling — Cron, Daemon, Catch-Up, and Failure Modes

**Purpose:** Reference for spell scheduling — definition syntax, CLI subcommands, daemon lifecycle, catch-up window semantics, and the failure modes you will hit. For the user-driven `/spell-schedule` walkthrough, see `.claude/skills/spell-schedule/SKILL.md`. For the engine itself (steps, args, runner), see `.claude/guidance/moflo-spell-engine.md`.

---

## When to Schedule a Spell

**Use scheduling when the spell must fire on a clock without a human present.** Don't reach for it for one-shot runs you can `flo spell cast` yourself.

| Trigger | Use |
|---------|-----|
| "Run X every weekday at 9am" | Schedule with `--cron` |
| "Run X every 6 hours" | Schedule with `--interval` |
| "Run X once at <future time>" | Schedule with `--at` |
| "Run X right now" | `flo spell cast -n X` — not a schedule |
| "Run X when file Y changes" | Hook or worker — not a schedule |

The scheduler is poll-based (1-minute floor). It is not a real-time trigger system.

---

## CLI Subcommands

**All scheduling lives under `flo spell schedule`.** No external cron, no second runtime.

| Subcommand | Purpose |
|------------|---------|
| `create -n <spell> --cron|--interval|--at <value>` | Create an ad-hoc schedule |
| `list` (alias `ls`) | List all schedules (definitions only — does NOT prove they fired) |
| `executions [--schedule <id>] [--limit N]` (alias `exec`, `history`) | Read the `schedule-executions` audit trail — the only way to confirm a schedule actually ran |
| `cancel <schedule-id>` | Disable a schedule (soft delete — record stays, `enabled: false`) |

**`list` shows what should fire. `executions` shows what did fire.** When verifying a new schedule, read `executions` — `list` only proves the record was written.

---

## Definition-Embedded Schedules

**A spell can declare its schedule inline in YAML.** The daemon registers it on every start.

```yaml
name: nightly-audit
schedule:
  cron: "0 2 * * *"        # UTC, 5-field cron (minute hour day-of-month month day-of-week)
  enabled: true            # default true; set false to keep the def without scheduling
  mofloLevel: hooks        # optional cap (narrows scheduler-level cap, never widens)
steps:
  - id: audit
    type: bash
    config:
      command: ./scripts/audit.sh
```

**Exactly one of `cron`, `interval`, or `at` must be set.** Validation rejects `cron: "invalid"`, `interval: "10w"` (only `s/m/h/d` units), or non-ISO datetimes — the spell fails to load before the scheduler ever sees it.

| Field | Type | Notes |
|-------|------|-------|
| `cron` | string | 5-field, UTC, no seconds field |
| `interval` | string | `<n>(s|m|h|d)` — `s` is allowed but ignored below 60s (poll floor) |
| `at` | string | ISO 8601 datetime, must be in the future at load time |
| `enabled` | bool | Defaults `true`; gate without deleting the record |
| `mofloLevel` | enum | `read` < `hooks` < `swarm`; per-schedule cap — narrows only |

Definition-embedded schedules get IDs of the form `sched-def-<spell-name>` (one per spell). Ad-hoc schedules get `sched-adhoc-<timestamp>-<rand>` (one per `flo spell schedule create`).

---

## Configuration in `moflo.yaml`

**The scheduler is on by default.** Disable it without affecting other daemon workers via `scheduler.enabled: false`.

```yaml
scheduler:
  enabled: true             # set false to disable scheduled spells
  pollIntervalMs: 60000     # how often the scheduler checks for due spells
  maxConcurrent: 2          # max concurrent scheduled spell executions
  catchUpWindowMs: 3600000  # max age (ms) of a missed run that should still fire
```

All four fields are optional. **Non-positive values are rejected at load and replaced with the defaults** — `pollIntervalMs: 0` won't silently break the poll loop.

Practical floors:
- `pollIntervalMs` is the granularity floor. Sub-minute schedules don't fire faster.
- `maxConcurrent: 1` serializes everything — useful when scheduled spells share a write lock.
- `catchUpWindowMs: 0` disables catch-up entirely; missed runs are skipped on restart.

---

## Storage Namespaces

**Two memory namespaces back the scheduler.** Both are project-scoped — schedules and history don't leak across projects.

| Namespace | Contents | Written by | Read by |
|-----------|----------|------------|---------|
| `scheduled-spells` | `SpellSchedule` records (id, spellName, timing, nextRunAt, enabled, args) | `flo spell schedule create`, definition load | Scheduler poll loop, `flo spell schedule list` |
| `schedule-executions` | `ScheduleExecution` audit records (startedAt, completedAt, success, error, duration, manualRun) | Scheduler at execute-start and execute-end | The Arcane Console, `flo spell schedule executions` |

When debugging "did my schedule fire?", read `schedule-executions` directly via `mcp__moflo__memory_list namespace=schedule-executions` if the CLI is unavailable.

---

## Catch-Up Window Semantics

**On daemon startup, schedules whose `nextRunAt` is in the past are evaluated against `catchUpWindowMs`.** This is the single most common source of "why didn't my run fire?" confusion.

| Lag (now − nextRunAt) | Behavior | Event emitted |
|-----------------------|----------|---------------|
| ≤ `pollIntervalMs` | Treated as routine cron drift; fires on next poll | `schedule:due` only |
| > `pollIntervalMs` and ≤ `catchUpWindowMs` | Fires on next poll as a caught-up run | `schedule:catchup` then `schedule:due` |
| > `catchUpWindowMs` | Skipped; `nextRunAt` advances past the missed slot | `schedule:skipped` |

This prevents a daemon that was offline for days from firing dozens of stale schedules at once.

**One-time `at:` schedules past their trigger get auto-disabled rather than rescheduled.** Re-enabling returns `null` because there's no future run to compute.

---

## Concurrency and Overlap Rules

**`maxConcurrent` (default 2) caps total in-flight scheduled spells.** Same-schedule overlap is never allowed regardless of `maxConcurrent`.

| Situation | Outcome |
|-----------|---------|
| Same schedule's prior run still in flight when next fire is due | New fire skipped (`schedule:skipped`); regular cadence continues |
| `maxConcurrent` saturated by other schedules | Due fire waits until next poll — nothing is queued |
| Manual run via `runScheduleNow` (dashboard "Run now") | Runs outside the poll loop; respects per-schedule overlap; does NOT advance `nextRunAt` |

There is no internal queue. A fire that didn't get a slot just shows up again on the next tick if it's still due.

---

## `mofloLevel` Composition for Scheduled Runs

**Three caps compose for every scheduled cast; the most restrictive wins.** Per-schedule caps can never widen the scheduler-level cap.

```
effectiveLevel = min(
  daemon.defaultMofloLevel,    // moflo.yaml scheduler-level cap
  spell.mofloLevel,            // spell definition cap
  schedule.mofloLevel          // per-schedule cap
)
```

Where `min` follows the level lattice `read < hooks < swarm`. A spell that needs `swarm` cannot run if any cap above it is `hooks` or `read` — it fails the capability gate at execute time, not at schedule create time.

---

## Daemon Prerequisite and Cross-Platform Autostart

**Schedules only fire while the daemon is running.** The scheduler is just code inside the daemon worker pool — no daemon, no schedules.

For survival across reboot, register the OS-native autostart service:

```bash
flo daemon install     # one-time setup; idempotent
flo daemon status      # shows registration AND running-process state
flo daemon uninstall   # remove the autostart hook
```

| Platform | Mechanism | Path |
|----------|-----------|------|
| macOS | launchd `LaunchAgent` | `~/Library/LaunchAgents/com.moflo.daemon.plist` |
| Linux | systemd `--user` unit | `~/.config/systemd/user/moflo-daemon.service` |
| Windows | Task Scheduler `ONLOGON` | Task name `MoFloDaemon` (via `schtasks`) |

`flo spell schedule create` prompts to install the autostart service when none is registered, so a freshly-scheduled spell survives the next reboot without an extra step. Cancel the last enabled schedule and the service is auto-removed (so an idle daemon doesn't autostart forever).

---

## Scheduler Event Types

**The scheduler emits typed events the daemon forwards to the dashboard event stream.** Subscribe via `scheduler.on(listener)`; the returned function unsubscribes. Listener exceptions are caught so a misbehaving subscriber can't break the poll loop.

| Event | When |
|-------|------|
| `schedule:catchup` | A missed run (lag > one poll interval, within catch-up window) is about to fire |
| `schedule:due` | A schedule is due (always emitted, with or without catch-up) |
| `schedule:started` | Execution started; an execution record exists in `schedule-executions` |
| `schedule:completed` | Execution finished with `success: true` |
| `schedule:failed` | Execution finished with `success: false` or threw |
| `schedule:skipped` | Execution skipped (overlap, expired catch-up, missing spell, sandbox-required mismatch) |
| `schedule:disabled` | Schedule disabled (manual cancel or auto-disable because the spell vanished) |

---

## Common Failure Modes

**Most "schedule isn't firing" reports trace to one of these.** Walk the list before reading scheduler source.

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `executions` is empty after the schedule's `nextRunAt` passed | Daemon not running | `flo daemon status` → `flo daemon start`; install autostart |
| `executions` shows `schedule:skipped` repeatedly | Same-schedule overlap (prior run never finished) | Check the spell — likely hung; cancel, fix, recreate |
| `executions` shows `schedule:skipped` once at startup | `nextRunAt` outside `catchUpWindowMs` | Expected after a long outage; next normal fire will land |
| Run fires but spell errors `SANDBOX_REQUIRED` | Spell needs `sandbox: required` and host doesn't supply one | Install sandbox runtime (Docker/bwrap) or remove `sandbox.required` from the spell |
| Schedule auto-disabled with `schedule:disabled` event | The spell name no longer resolves in the grimoire | Restore the spell file, then re-enable the schedule |
| Cron fires an hour off | Cron is UTC; user-typed time was local | Convert to UTC before `--cron`; see `/spell-schedule` skill |
| `executions` shows `success: true` but no side-effect | Spell ran but interpolation/credentials failed silently inside a step | Run the spell manually (`flo spell cast -n <name>`) and inspect step output |

---

## Verification Recipe (Schedule Round-Trip)

**To confirm a fresh schedule works end-to-end without waiting for the cron tick:**

1. Create the schedule with `--interval 1m` (or `--at` near the current time).
2. `flo spell schedule list` → verify `nextRunAt` is in the next minute.
3. `flo daemon status` → confirm running.
4. Wait one poll cycle (~60s).
5. `flo spell schedule executions --schedule <id>` → expect one row with `success: true`.
6. Cancel and recreate with the real cadence.

If step 5 is empty, jump straight to the failure-modes table above — don't loop in step 4.

---

## See Also

- `.claude/skills/spell-schedule/SKILL.md` — User-facing walkthrough for creating a schedule (procedural counterpart to this reference)
- `.claude/guidance/moflo-spell-engine.md` — Definition format, step types, variable interpolation
- `.claude/guidance/moflo-spell-runner.md` — Execution lifecycle, dry-run, layering, errors
- `.claude/guidance/moflo-spell-sandboxing.md` — Capability levels (`read`/`hooks`/`swarm`) referenced by the `mofloLevel` cap
- `.claude/guidance/moflo-spell-troubleshooting.md` — Broader spell failure-mode catalog beyond scheduling
- `.claude/guidance/moflo-core-guidance.md` — CLI, hooks, daemon, MCP reference hub
