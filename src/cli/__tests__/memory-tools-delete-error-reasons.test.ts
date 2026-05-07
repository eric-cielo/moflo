/**
 * Issue #963 — memory_delete must surface a human-readable error
 * whenever the delete fails, instead of silently returning
 * { success: false, deleted: false }.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPTool } from '../mcp-tools/types.js';

const deleteSpy = vi.fn();

vi.mock('../memory/memory-initializer.js', () => ({
  storeEntry: vi.fn(),
  searchEntries: vi.fn(),
  listEntries: vi.fn(),
  getEntry: vi.fn(),
  deleteEntry: deleteSpy,
  initializeMemoryDatabase: vi.fn(async () => ({ success: true, dbPath: '' })),
  checkMemoryInitialization: vi.fn(async () => ({ initialized: true, dbPath: '', tableExists: true, version: '3.0.0' })),
}));

vi.mock('../services/spell-gate.js', () => ({
  GateService: class { recordMemorySearched() { /* noop */ } },
}));

beforeEach(() => {
  deleteSpy.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function getDeleteTool(): Promise<MCPTool> {
  const mod = await import('../mcp-tools/memory-tools.js');
  const tool = (mod.memoryTools as MCPTool[]).find(t => t.name === 'memory_delete');
  if (!tool) throw new Error('memory_delete not registered');
  return tool;
}

describe('memory_delete MCP handler — error surfacing (#963)', () => {
  it('returns success:true and deleted:true on a real deletion', async () => {
    deleteSpy.mockResolvedValueOnce({
      success: true,
      deleted: true,
      key: 'k1',
      namespace: 'ns',
      remainingEntries: 0,
    });

    const tool = await getDeleteTool();
    const out = await tool.handler({ key: 'k1', namespace: 'ns' }) as Record<string, unknown>;

    expect(out.success).toBe(true);
    expect(out.deleted).toBe(true);
    expect(out.error).toBeUndefined();
  });

  it('passes through a "key not found" error from the storage layer', async () => {
    deleteSpy.mockResolvedValueOnce({
      success: false,
      deleted: false,
      key: 'missing',
      namespace: 'ns',
      remainingEntries: 0,
      error: "Key 'missing' not found in namespace 'ns'",
    });

    const tool = await getDeleteTool();
    const out = await tool.handler({ key: 'missing', namespace: 'ns' }) as Record<string, unknown>;

    expect(out.success).toBe(false);
    expect(out.deleted).toBe(false);
    expect(out.error).toBe("Key 'missing' not found in namespace 'ns'");
  });

  it('synthesises an error when the storage layer returns deleted:false with no reason', async () => {
    // Simulates the legacy silent-failure shape; should NEVER appear post-fix
    // from the bridge, but the handler still belt-and-braces it.
    deleteSpy.mockResolvedValueOnce({
      success: true,
      deleted: false,
      key: 'k2',
      namespace: 'ns',
      remainingEntries: 0,
    });

    const tool = await getDeleteTool();
    const out = await tool.handler({ key: 'k2', namespace: 'ns' }) as Record<string, unknown>;

    expect(out.success).toBe(false);
    expect(out.deleted).toBe(false);
    expect(typeof out.error).toBe('string');
    expect(out.error as string).toContain("k2");
    expect(out.error as string).toContain("ns");
  });

  it('surfaces a thrown exception as the error field', async () => {
    deleteSpy.mockRejectedValueOnce(new Error('disk write failed'));

    const tool = await getDeleteTool();
    const out = await tool.handler({ key: 'k3', namespace: 'ns' }) as Record<string, unknown>;

    expect(out.success).toBe(false);
    expect(out.deleted).toBe(false);
    expect(out.error).toBe('disk write failed');
  });

  it('defaults namespace to "default" when omitted', async () => {
    deleteSpy.mockResolvedValueOnce({
      success: true,
      deleted: true,
      key: 'k4',
      namespace: 'default',
      remainingEntries: 0,
    });

    const tool = await getDeleteTool();
    const out = await tool.handler({ key: 'k4' }) as Record<string, unknown>;

    expect(deleteSpy).toHaveBeenCalledWith({ key: 'k4', namespace: 'default' });
    expect(out.namespace).toBe('default');
    expect(out.success).toBe(true);
  });
});
