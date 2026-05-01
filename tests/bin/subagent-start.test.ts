/**
 * SubagentStart hook parity tests (story #800).
 *
 * The SubagentStart hook injects a memory-first directive into every
 * spawned subagent's bootstrap context. Story #800 moved the directive
 * out of the cjs hook source and into a sibling JSON file so the TS spawn
 * surfaces (epic #798 stories 3 + 9) can read the same canonical text.
 * These tests pin two contracts:
 *   1. The hook's emitted `additionalContext` matches the JSON byte-for-byte
 *      — drift breaks the single-source-of-truth promise across consumers.
 *   2. The cjs hook's inline FALLBACK string (defense-in-depth for a missing
 *      JSON file) also matches the JSON. Without this, the fallback can rot
 *      silently when the canonical directive is updated.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const HELPERS_DIR = resolve(__dirname, '../../.claude/helpers');
const HOOK_PATH = resolve(HELPERS_DIR, 'subagent-start.cjs');
const JSON_PATH = resolve(HELPERS_DIR, 'subagent-bootstrap.json');
const TS_MODULE_PATH = resolve(__dirname, '../../src/cli/services/subagent-bootstrap.ts');

interface HookOutput {
  hookSpecificOutput?: {
    hookEventName?: string;
    additionalContext?: string;
  };
}

describe('subagent-start.cjs', () => {
  let hookOutput: HookOutput;
  let canonicalDirective: string;

  beforeAll(() => {
    canonicalDirective = (JSON.parse(readFileSync(JSON_PATH, 'utf-8')) as { directive: string }).directive;
    const stdout = execFileSync('node', [HOOK_PATH], {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    hookOutput = JSON.parse(stdout) as HookOutput;
  });

  it('shipped sibling JSON exists', () => {
    expect(existsSync(JSON_PATH)).toBe(true);
  });

  it('emits the SubagentStart hook envelope', () => {
    expect(hookOutput.hookSpecificOutput?.hookEventName).toBe('SubagentStart');
    expect(typeof hookOutput.hookSpecificOutput?.additionalContext).toBe('string');
    expect(hookOutput.hookSpecificOutput?.additionalContext?.length ?? 0).toBeGreaterThan(0);
  });

  it('additionalContext matches subagent-bootstrap.json byte-for-byte', () => {
    expect(hookOutput.hookSpecificOutput?.additionalContext).toBe(canonicalDirective);
  });

  it('cjs FALLBACK literal matches the canonical directive', () => {
    const cjsSource = readFileSync(HOOK_PATH, 'utf-8');
    expect(cjsSource).toContain(canonicalDirective);
  });

  it('ts FALLBACK literal matches the canonical directive', () => {
    const tsSource = readFileSync(TS_MODULE_PATH, 'utf-8');
    expect(tsSource).toContain(canonicalDirective);
  });
});
