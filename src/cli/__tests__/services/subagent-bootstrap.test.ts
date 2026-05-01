/**
 * Subagent bootstrap directive parity test (story #800).
 *
 * The TS export `SUBAGENT_BOOTSTRAP_DIRECTIVE` is one of the consumers of
 * `.claude/helpers/subagent-bootstrap.json` — the cjs SubagentStart hook is
 * the other (covered by `tests/bin/subagent-start.test.ts`). Both paths
 * must land on the same string; otherwise spawn surfaces drift apart and
 * the "single source of truth" promise of story #800 breaks silently.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SUBAGENT_BOOTSTRAP_DIRECTIVE } from '../../services/subagent-bootstrap.js';

const REPO_ROOT = resolve(__dirname, '../../../..');
const JSON_PATH = resolve(REPO_ROOT, '.claude/helpers/subagent-bootstrap.json');

describe('SUBAGENT_BOOTSTRAP_DIRECTIVE', () => {
  it('canonical JSON ships at .claude/helpers/subagent-bootstrap.json', () => {
    expect(existsSync(JSON_PATH)).toBe(true);
  });

  it('matches subagent-bootstrap.json byte-for-byte', () => {
    const json = JSON.parse(readFileSync(JSON_PATH, 'utf-8')) as { directive: string };
    expect(SUBAGENT_BOOTSTRAP_DIRECTIVE).toBe(json.directive);
  });

  it('non-empty string', () => {
    expect(typeof SUBAGENT_BOOTSTRAP_DIRECTIVE).toBe('string');
    expect(SUBAGENT_BOOTSTRAP_DIRECTIVE.length).toBeGreaterThan(0);
  });

  it('names the load-bearing memory_search tool', () => {
    expect(SUBAGENT_BOOTSTRAP_DIRECTIVE).toContain('mcp__moflo__memory_search');
  });
});
