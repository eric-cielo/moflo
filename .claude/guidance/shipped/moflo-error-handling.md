# Error Handling Standards

**Purpose:** Mandatory error handling rules for all MoFlo source code. Silent failures are forbidden.

---

## No Silent Catch Blocks

**Never write `catch {}` or `catch { /* noop */ }` that discards error information entirely.** Every catch block MUST do at least one of:

1. Log the error (e.g., `console.warn`, `console.error`, or a structured logger)
2. Re-throw the error (possibly wrapped with context)
3. Return a result that carries the error message to the caller

| Pattern | Verdict |
|---------|---------|
| `catch {}` | **FORBIDDEN** — error is invisible |
| `catch { /* best effort */ }` | **FORBIDDEN** — comment does not make it visible |
| `catch (err) { console.warn(\`[context]: ${err.message}\`); }` | **OK** — error is logged |
| `catch (err) { return { success: false, error: err.message }; }` | **OK** — error is surfaced to caller |
| `catch (err) { throw new ContextualError('step failed', { cause: err }); }` | **OK** — error is re-thrown with context |

**Why:** Silent failures are the #1 source of debugging dead-ends in MoFlo. When errors are swallowed, the epic command prints "failed" with zero information, the dashboard shows nothing, and the user has to guess what went wrong. This has caused repeated multi-attempt debugging sessions.

**How to apply:** When writing any `try/catch`, ask: "If this fails, will someone be able to figure out why?" If the answer is no, log the error. This applies to all code paths, including "best-effort" operations like memory writes and dashboard updates.

---

## Error Propagation Must Preserve Detail

**When catching and re-throwing or returning errors, preserve the original error message and context.** Do not reduce a detailed error to a generic string.

| Bad | Good |
|-----|------|
| `return { error: 'Step failed' }` | `return { error: \`Step \${stepId} failed: \${err.message}\` }` |
| `console.log('Error:', err.message)` (for structured errors with sub-fields) | Log `err.message`, `err.code`, `err.details`, `err.stderr` — all available fields |

---

## Callbacks Must Fire for All Outcomes

**Progress/completion callbacks (e.g., `onStepComplete`) MUST fire for every step, including failed and cancelled steps.** Skipping the callback on failure makes the failing step invisible to the caller.

---

## Transient Errors Must Use Retry + Circuit Breaker

**Wrap every transient-failure-capable operation in a retry helper with exponential backoff and a circuit breaker.** One-shot try-and-log on a transient class strands users in partial-state loops — a representative incident: a Windows file-lock + AV scan race left stale `.claude/helpers/gate.cjs` across 8+ moflo bumps because each per-version sync swallowed the EBUSY without retrying.

| Element | Default |
|---------|---------|
| Retryable codes | `EBUSY`, `EPERM`, `EACCES`, `EAGAIN`, `ETIMEDOUT`, `ECONNRESET`; HTTP 5xx/429/408 |
| Hard codes (no retry) | `ENOENT`, `EISDIR`, `EEXIST`, validation errors |
| Backoff (filesystem) | `[50, 200, 800]ms` — 3 retries |
| Circuit breaker | Open after 5 distinct failures; tail runs with `maxAttempts=1` |
| Exhaustion handling | Log error AND name the healer (e.g. `run 'flo doctor --fix' to repair`) |

**Reference implementation:** `syncWithRetry` in `bin/session-start-launcher.mjs`. Use it; do not invent ad-hoc retries.

```js
// FORBIDDEN
try { copyFileSync(src, dest); } catch (err) { console.warn(err.message); }

// CORRECT
const result = await syncWithRetry(() => copyFileSync(src, dest));
if (!result.ok) syncFailures.push({ key, message: `${errMessage(result.err)} (retried after ${result.code})` });
```

---

## See Also

- `.claude/guidance/moflo-source-hygiene.md` — General source code standards
- `.claude/guidance/moflo-cross-platform.md` — Cross-platform rules
