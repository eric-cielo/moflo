# AIDefence

> **Note:** AIDefence is bundled inside `moflo`. There is no separate `@moflo/aidefence` npm package — collapsed into the moflo tree per [ADR-0001](../adr/0001-collapse-moflo-workspace-packages.md). Use the CLI command and MCP tools below.

AIDefence is moflo's AI-manipulation defense layer: prompt-injection and jailbreak detection, PII scanning, and self-learning threat patterns with sub-millisecond latency. Source lives at `src/cli/aidefence/`.

---

## CLI

```bash
moflo security defend --input "<text to scan>"
moflo security defend --file path/to/scan.txt
moflo security defend --quick                     # fast boolean check
moflo security defend --stats                     # detection statistics
```

The `--learn` flag (default: on) records detections so the pattern set adapts over time. The MofloDb HNSW vector store is used automatically when the memory bridge is available; otherwise the in-memory store is used.

---

## MCP tools

The MCP server (`flo mcp serve` or via Claude Code) exposes six tools:

| Tool | Purpose |
|------|---------|
| `aidefence_scan` | Scan input for threats, return per-threat severity/confidence/PII flags. Supports `quick: true` for the fast path. |
| `aidefence_analyze` | Deep analysis: detection + best mitigation + similar known patterns (HNSW search). |
| `aidefence_stats` | Detection counts, average latency, learned-pattern total, mitigation effectiveness. |
| `aidefence_learn` | Record feedback (was-accurate, user verdict, mitigation success) so detection improves. |
| `aidefence_is_safe` | Boolean-only quick check. Cheapest call. |
| `aidefence_has_pii` | PII-only check (emails, SSNs, API keys, passwords, credit cards). |

All six route through the same singleton, so the MofloDb vector store is wired once per process.

---

## Threat categories

| Category | Severity | Examples |
|----------|----------|----------|
| Instruction override | Critical | "Ignore previous instructions" |
| Jailbreak | Critical | DAN, "developer mode", "bypass restrictions" |
| Role switching | High | "You are now…", "Act as…" |
| Context manipulation | Critical | Fake system messages, delimiter abuse |
| Encoding attacks | Medium | Base64 / ROT13 obfuscation |
| Social engineering | Low–Medium | Hypothetical framing, "for research" |

50+ built-in patterns. Detection latency is typically under 1ms; the learning + HNSW search path adds milliseconds proportional to vector-store size.

---

## Self-learning

`aidefence_learn` (or `learnFromDetection()` on the facade) records:

- Whether the detection was accurate (`wasAccurate`).
- Optional user verdict text.
- Optional mitigation strategy + success flag (`block`, `sanitize`, `warn`, `log`, `escalate`, `transform`, `redirect`).

Patterns persist across restarts via the `aidefence:` namespace prefix in the shared `.swarm/memory.db` (when MofloDb is available). Best mitigation per threat type is queryable via `getBestMitigation(threatType)` on the facade.

---

## Adding new patterns

Patterns are defined in `src/cli/aidefence/domain/services/threat-detection-service.ts`:

```typescript
const PROMPT_INJECTION_PATTERNS: ThreatPattern[] = [
  {
    pattern: /your-regex-here/i,
    type: 'jailbreak',
    severity: 'critical',
    description: 'Description of the threat',
    baseConfidence: 0.95,
  },
  // ... more patterns
];
```

Add a pattern, add a unit test in `src/cli/__tests__/aidefence/threat-detection.test.ts`, ship.

---

## Tests

```bash
npm test -- src/cli/__tests__/aidefence
```

Three suites: detection, learning, integration. The MCP-tool surface is covered by `src/cli/__tests__/mcp-tools-deep.test.ts`.
