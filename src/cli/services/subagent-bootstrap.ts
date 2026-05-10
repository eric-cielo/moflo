/**
 * Single source of truth for the subagent memory-first directive.
 *
 * `.claude/helpers/subagent-bootstrap.json` at the moflo package root is the
 * canonical directive string. The cjs SubagentStart hook
 * (`.claude/helpers/subagent-start.cjs`) reads it via `__dirname`; this TS
 * module reads the same file via `locateMofloRootPath` so every spawn surface
 * — the hook today, `agent_spawn` after story #801, hive-mind worker
 * registration after story #807 — injects byte-identical text.
 *
 * The inline FALLBACK below is intentionally a second copy of the string,
 * required as defense-in-depth so a stale install missing the JSON file (or
 * a partially-published tarball) cannot silently spawn agents without the
 * memory-first directive. The parity test in
 * `src/cli/__tests__/services/subagent-bootstrap.test.ts` pins the FALLBACK
 * to the JSON at commit time so the two cannot drift unnoticed.
 */
import { readFileSync } from 'node:fs';
import { locateMofloRootPath } from './moflo-require.js';

const BOOTSTRAP_JSON_REL = '.claude/helpers/subagent-bootstrap.json';

// Defense-in-depth copy of the canonical directive in subagent-bootstrap.json.
// Kept as a single-line literal so the parity test can verify it matches the
// JSON via plain substring containment.
const FALLBACK_DIRECTIVE = 'MANDATORY FIRST ACTION: Your very first tool call MUST be mcp__moflo__memory_search (any query, any namespace). The memory-first gate WILL BLOCK all Glob, Grep, and Read calls until you do this. After memory search, follow `.claude/guidance/moflo-subagents.md` protocol. When search returns chunk hits, traverse via mcp__moflo__memory_get_neighbors before retrieving — see `.claude/guidance/moflo-memory-protocol.md`.';

function loadDirective(): string {
  const jsonPath = locateMofloRootPath(BOOTSTRAP_JSON_REL);
  if (!jsonPath) {
    process.stderr.write(
      `[subagent-bootstrap] ${BOOTSTRAP_JSON_REL} not found in moflo package — using inline fallback\n`,
    );
    return FALLBACK_DIRECTIVE;
  }
  let raw: string;
  try {
    raw = readFileSync(jsonPath, 'utf8');
  } catch (err) {
    process.stderr.write(
      `[subagent-bootstrap] read failed: ${(err as Error).message} — using inline fallback\n`,
    );
    return FALLBACK_DIRECTIVE;
  }
  try {
    const data = JSON.parse(raw) as { directive?: unknown };
    if (typeof data.directive === 'string' && data.directive.length > 0) {
      return data.directive;
    }
    process.stderr.write(
      '[subagent-bootstrap] subagent-bootstrap.json missing string `directive` — using inline fallback\n',
    );
  } catch (err) {
    process.stderr.write(
      `[subagent-bootstrap] subagent-bootstrap.json parse failed: ${(err as Error).message} — using inline fallback\n`,
    );
  }
  return FALLBACK_DIRECTIVE;
}

/**
 * The canonical directive string injected into every subagent's bootstrap
 * context. Resolved once at module load — the JSON file is shipped in the
 * tarball and never rewritten at runtime, so caching is safe.
 */
export const SUBAGENT_BOOTSTRAP_DIRECTIVE: string = loadDirective();
