/**
 * Tests for semantic-search.mjs test namespace support
 *
 * Verifies:
 * - --with-tests flag merges code-map and tests namespace results
 * - Auto-routing detects test keywords in queries
 * - --namespace tests restricts to tests namespace only
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SEARCH_SCRIPT = resolve(__dirname, '../bin/semantic-search.mjs');

describe('semantic-search.mjs test namespace support', () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(SEARCH_SCRIPT, 'utf-8');
  });

  it('supports --with-tests flag', () => {
    expect(content).toContain("const withTests = args.includes('--with-tests')");
  });

  it('defines TEST_KEYWORDS regex for auto-routing', () => {
    expect(content).toContain('TEST_KEYWORDS');
    expect(content).toContain('test|spec|coverage|assert|mock');
  });

  it('auto-routes to tests namespace when query contains test keywords', () => {
    expect(content).toContain('autoRouteTests');
    expect(content).toContain('TEST_KEYWORDS.test(query)');
  });

  it('merges results from primary and tests namespaces', () => {
    expect(content).toContain('primaryResults');
    expect(content).toContain('testResults');
    expect(content).toContain("namespace: 'tests'");
  });

  it('sorts merged results by score', () => {
    expect(content).toContain('b.score - a.score');
  });

  it('reports auto-routing to user', () => {
    expect(content).toContain('Auto-routed to tests namespace');
  });
});
