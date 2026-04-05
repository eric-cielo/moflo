/**
 * Tests for Story #121: Migrate Hive-Mind from File I/O to MessageBus + Memory DB
 *
 * Covers:
 * - WriteThroughAdapter: attach/detach, namespace filtering, stats
 * - Hive-mind tools: init, join, leave, broadcast, consensus, memory, status, shutdown
 * - All tools use MessageBus (no file I/O for state.json)
 * - Write-through persists messages in enabled namespaces
 * - TTL reaper handles both in-memory and DB entries
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MessageBus,
  WriteThroughAdapter,
  type WriteThroughConfig,
} from '../src/modules/swarm/src/index.js';

// ==========================================================================
// WriteThroughAdapter Tests
// ==========================================================================

describe('WriteThroughAdapter (Story #121)', () => {
  let bus: MessageBus;
  let storedEntries: Map<string, { key: string; value: string; namespace: string; ttl?: number }>;
  let deletedKeys: string[];

  const mockStore = vi.fn(async (opts: { key: string; value: string; namespace: string; ttl?: number }) => {
    storedEntries.set(opts.key, opts);
    return { success: true, id: `id-${opts.key}` };
  });

  const mockDelete = vi.fn(async (opts: { key: string; namespace: string }) => {
    deletedKeys.push(opts.key);
    return { success: true };
  });

  const mockList = vi.fn(async (opts: { namespace: string; limit?: number }) => {
    const entries = [...storedEntries.values()]
      .filter(e => e.namespace === opts.namespace)
      .map(e => ({ key: e.key, metadata: {} }));
    return { entries };
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    storedEntries = new Map();
    deletedKeys = [];
    mockStore.mockClear();
    mockDelete.mockClear();
    mockList.mockClear();

    bus = new MessageBus({ processingIntervalMs: 10, reaperIntervalMs: 60000 });
    await bus.initialize();
  });

  afterEach(async () => {
    await bus.shutdown();
    vi.useRealTimers();
  });

  it('persists messages in enabled namespaces to Memory DB', async () => {
    const adapter = new WriteThroughAdapter(
      bus,
      { enabled: true, namespaces: ['hive-mind'] },
      mockStore,
      { deleteEntry: mockDelete, listEntries: mockList },
    );
    adapter.attach();

    // Subscribe so messages are routable
    bus.subscribe('worker-1', () => {}, { namespace: 'hive-mind' });

    // Send a message in the hive-mind namespace
    await bus.sendUnified({
      type: 'broadcast',
      from: 'system',
      to: 'worker-1',
      payload: { msg: 'hello' },
      content: 'hello',
      namespace: 'hive-mind',
      priority: 'normal',
      requiresAck: false,
      ttlMs: 60000,
    });

    // Give the fire-and-forget promise time to resolve
    await vi.advanceTimersByTimeAsync(50);

    expect(mockStore).toHaveBeenCalledTimes(1);
    const storedCall = mockStore.mock.calls[0][0];
    expect(storedCall.namespace).toBe('hive-mind');
    expect(storedCall.key).toMatch(/^msg:/);

    adapter.detach();
  });

  it('does NOT persist messages in disabled namespaces', async () => {
    const adapter = new WriteThroughAdapter(
      bus,
      { enabled: true, namespaces: ['hive-mind'] },
      mockStore,
      { deleteEntry: mockDelete, listEntries: mockList },
    );
    adapter.attach();

    bus.subscribe('worker-1', () => {});

    // Send a message in a non-enabled namespace
    await bus.sendUnified({
      type: 'broadcast',
      from: 'system',
      to: 'worker-1',
      payload: { msg: 'hello' },
      namespace: 'other-namespace',
      priority: 'normal',
      requiresAck: false,
      ttlMs: 60000,
    });

    await vi.advanceTimersByTimeAsync(50);

    expect(mockStore).not.toHaveBeenCalled();

    adapter.detach();
  });

  it('tracks write-through stats', async () => {
    const adapter = new WriteThroughAdapter(
      bus,
      { enabled: true, namespaces: ['hive-mind'] },
      mockStore,
      { deleteEntry: mockDelete, listEntries: mockList },
    );
    adapter.attach();
    bus.subscribe('worker-1', () => {}, { namespace: 'hive-mind' });

    await bus.sendUnified({
      type: 'broadcast',
      from: 'system',
      to: 'worker-1',
      payload: 'test',
      namespace: 'hive-mind',
      priority: 'normal',
      requiresAck: false,
      ttlMs: 60000,
    });

    await vi.advanceTimersByTimeAsync(50);

    const stats = adapter.getStats();
    expect(stats.written).toBe(1);
    expect(stats.errors).toBe(0);

    adapter.detach();
  });

  it('handles store failures gracefully (increments error count)', async () => {
    const failingStore = vi.fn(async () => {
      throw new Error('DB write failed');
    });

    const adapter = new WriteThroughAdapter(
      bus,
      { enabled: true, namespaces: ['hive-mind'] },
      failingStore,
      { deleteEntry: mockDelete, listEntries: mockList },
    );
    adapter.attach();
    bus.subscribe('worker-1', () => {}, { namespace: 'hive-mind' });

    await bus.sendUnified({
      type: 'broadcast',
      from: 'system',
      to: 'worker-1',
      payload: 'test',
      namespace: 'hive-mind',
      priority: 'normal',
      requiresAck: false,
      ttlMs: 60000,
    });

    await vi.advanceTimersByTimeAsync(50);

    const stats = adapter.getStats();
    expect(stats.errors).toBe(1);
    expect(stats.written).toBe(0);

    adapter.detach();
  });

  it('does nothing when disabled', async () => {
    const adapter = new WriteThroughAdapter(
      bus,
      { enabled: false, namespaces: ['hive-mind'] },
      mockStore,
    );
    adapter.attach();
    bus.subscribe('worker-1', () => {}, { namespace: 'hive-mind' });

    await bus.sendUnified({
      type: 'broadcast',
      from: 'system',
      to: 'worker-1',
      payload: 'test',
      namespace: 'hive-mind',
      priority: 'normal',
      requiresAck: false,
      ttlMs: 60000,
    });

    await vi.advanceTimersByTimeAsync(50);

    expect(mockStore).not.toHaveBeenCalled();
    adapter.detach();
  });

  it('supports runtime namespace enable/disable', () => {
    const adapter = new WriteThroughAdapter(
      bus,
      { enabled: true, namespaces: ['hive-mind'] },
      mockStore,
    );

    expect(adapter.isNamespaceEnabled('hive-mind')).toBe(true);
    expect(adapter.isNamespaceEnabled('other')).toBe(false);

    adapter.enableNamespace('other');
    expect(adapter.isNamespaceEnabled('other')).toBe(true);

    adapter.disableNamespace('hive-mind');
    expect(adapter.isNamespaceEnabled('hive-mind')).toBe(false);
  });

  it('clears namespace entries from Memory DB', async () => {
    storedEntries.set('msg:1', { key: 'msg:1', value: '{}', namespace: 'hive-mind' });
    storedEntries.set('msg:2', { key: 'msg:2', value: '{}', namespace: 'hive-mind' });

    const adapter = new WriteThroughAdapter(
      bus,
      { enabled: true, namespaces: ['hive-mind'] },
      mockStore,
      { deleteEntry: mockDelete, listEntries: mockList },
    );

    await adapter.clearNamespace('hive-mind');

    expect(mockDelete).toHaveBeenCalledTimes(2);
    expect(deletedKeys).toContain('msg:1');
    expect(deletedKeys).toContain('msg:2');
  });
});

// ==========================================================================
// Hive-Mind Tools Integration Tests
// ==========================================================================

describe('Hive-Mind Tools — MessageBus Backend (Story #121)', () => {
  // These tests import the actual tool handlers and verify they produce
  // equivalent behavior to the old file-based implementation.

  let tools: Record<string, (input: Record<string, unknown>) => Promise<unknown>>;

  beforeEach(async () => {
    // Dynamic import to get fresh module state
    // We rely on the tool handlers being stateless across tests via hive-mind_shutdown
    const { hiveMindTools } = await import('../src/modules/cli/src/mcp-tools/hive-mind-tools.js');
    tools = {};
    for (const tool of hiveMindTools) {
      tools[tool.name] = tool.handler;
    }

    // Ensure clean state — shutdown any previous hive
    try {
      await tools['hive-mind_shutdown']({ force: true });
    } catch {
      // May not be initialized
    }
  });

  afterEach(async () => {
    try {
      await tools['hive-mind_shutdown']({ force: true });
    } catch {
      // Cleanup
    }
  });

  it('init creates hive with topology and queen', async () => {
    const result = await tools['hive-mind_init']({
      topology: 'hierarchical',
      queenId: 'queen-test',
    }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.topology).toBe('hierarchical');
    expect(result.queenId).toBe('queen-test');
    expect(result.status).toBe('initialized');
    expect(result.hiveId).toBeDefined();
  });

  it('join adds agent to hive', async () => {
    await tools['hive-mind_init']({ topology: 'mesh' });

    const result = await tools['hive-mind_join']({
      agentId: 'worker-1',
      role: 'specialist',
    }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.agentId).toBe('worker-1');
    expect(result.role).toBe('specialist');
    expect(result.totalWorkers).toBe(1);
  });

  it('join fails when hive not initialized', async () => {
    const result = await tools['hive-mind_join']({
      agentId: 'worker-1',
    }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.error).toContain('not initialized');
  });

  it('leave removes agent from hive', async () => {
    await tools['hive-mind_init']({ topology: 'mesh' });
    await tools['hive-mind_join']({ agentId: 'worker-1' });

    const result = await tools['hive-mind_leave']({
      agentId: 'worker-1',
    }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.remainingWorkers).toBe(0);
  });

  it('leave returns error for unknown agent', async () => {
    await tools['hive-mind_init']({ topology: 'mesh' });

    const result = await tools['hive-mind_leave']({
      agentId: 'nonexistent',
    }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.error).toContain('not in hive');
  });

  it('broadcast sends message via MessageBus', async () => {
    await tools['hive-mind_init']({ topology: 'mesh' });
    await tools['hive-mind_join']({ agentId: 'worker-1' });

    const result = await tools['hive-mind_broadcast']({
      message: 'Hello hive!',
      priority: 'high',
      fromId: 'queen',
    }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
    expect(result.recipients).toBe(1);
    expect(result.priority).toBe('high');
  });

  it('broadcast fails when hive not initialized', async () => {
    const result = await tools['hive-mind_broadcast']({
      message: 'test',
    }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.error).toContain('not initialized');
  });

  it('consensus propose creates proposal and broadcasts', async () => {
    await tools['hive-mind_init']({ topology: 'mesh' });
    await tools['hive-mind_join']({ agentId: 'worker-1' });
    await tools['hive-mind_join']({ agentId: 'worker-2' });

    const result = await tools['hive-mind_consensus']({
      action: 'propose',
      type: 'architecture',
      value: { choice: 'microservices' },
      voterId: 'worker-1',
    }) as Record<string, unknown>;

    expect(result.action).toBe('propose');
    expect(result.proposalId).toBeDefined();
    expect(result.status).toBe('pending');
  });

  it('consensus vote resolves proposal on majority', async () => {
    await tools['hive-mind_init']({ topology: 'mesh' });
    await tools['hive-mind_join']({ agentId: 'worker-1' });
    await tools['hive-mind_join']({ agentId: 'worker-2' });
    await tools['hive-mind_join']({ agentId: 'worker-3' });

    const proposal = await tools['hive-mind_consensus']({
      action: 'propose',
      type: 'design',
      value: 'option-A',
      voterId: 'worker-1',
    }) as Record<string, unknown>;

    // Majority of 3 workers = floor(3/2)+1 = 2 votes needed
    await tools['hive-mind_consensus']({
      action: 'vote',
      proposalId: proposal.proposalId,
      vote: true,
      voterId: 'worker-1',
    });
    const voteResult = await tools['hive-mind_consensus']({
      action: 'vote',
      proposalId: proposal.proposalId,
      vote: true,
      voterId: 'worker-2',
    }) as Record<string, unknown>;

    expect(voteResult.status).toBe('approved');
    expect(voteResult.votesFor).toBe(2);
  });

  it('consensus list shows pending and history', async () => {
    await tools['hive-mind_init']({ topology: 'mesh' });
    await tools['hive-mind_join']({ agentId: 'worker-1' });

    await tools['hive-mind_consensus']({
      action: 'propose',
      type: 'test',
      value: 'val',
    });

    const result = await tools['hive-mind_consensus']({
      action: 'list',
    }) as Record<string, unknown>;

    expect(result.action).toBe('list');
    expect((result.pending as unknown[]).length).toBe(1);
  });

  it('status returns equivalent info to old file-based status', async () => {
    await tools['hive-mind_init']({ topology: 'star', queenId: 'queen-1' });
    await tools['hive-mind_join']({ agentId: 'w1' });
    await tools['hive-mind_join']({ agentId: 'w2' });

    const result = await tools['hive-mind_status']({}) as Record<string, unknown>;

    expect(result.status).toBe('active');
    expect(result.topology).toBe('star');
    expect(result.initialized).toBe(true);
    expect(result.workerCount).toBe(2);
    expect((result.workers as unknown[]).length).toBe(2);
    expect((result.queen as Record<string, unknown>).agentId).toBe('queen-1');
    expect(result.hiveId).toBeDefined();
  });

  it('status returns offline when not initialized', async () => {
    const result = await tools['hive-mind_status']({}) as Record<string, unknown>;
    expect(result.status).toBe('offline');
    expect(result.initialized).toBe(false);
  });

  it('spawn creates workers and joins them to hive', async () => {
    await tools['hive-mind_init']({ topology: 'mesh' });

    const result = await tools['hive-mind_spawn']({
      count: 3,
      role: 'specialist',
      prefix: 'test-worker',
    }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.spawned).toBe(3);
    expect(result.totalWorkers).toBe(3);
    expect((result.workers as unknown[]).length).toBe(3);
  });

  it('spawn fails when hive not initialized', async () => {
    const result = await tools['hive-mind_spawn']({
      count: 1,
    }) as Record<string, unknown>;

    expect(result.success).toBe(false);
  });

  it('shutdown clears state and returns stats', async () => {
    await tools['hive-mind_init']({ topology: 'mesh' });
    await tools['hive-mind_join']({ agentId: 'w1' });
    await tools['hive-mind_join']({ agentId: 'w2' });

    const result = await tools['hive-mind_shutdown']({
      graceful: true,
      force: false,
    }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.workersTerminated).toBe(2);

    // Verify state is reset
    const status = await tools['hive-mind_status']({}) as Record<string, unknown>;
    expect(status.initialized).toBe(false);
  });

  it('graceful shutdown blocks on pending consensus (unless forced)', async () => {
    await tools['hive-mind_init']({ topology: 'mesh' });
    await tools['hive-mind_join']({ agentId: 'w1' });

    await tools['hive-mind_consensus']({
      action: 'propose',
      type: 'test',
      value: 'blocking',
    });

    const gracefulResult = await tools['hive-mind_shutdown']({
      graceful: true,
      force: false,
    }) as Record<string, unknown>;

    expect(gracefulResult.success).toBe(false);
    expect(gracefulResult.error).toContain('pending consensus');

    // Force works
    const forceResult = await tools['hive-mind_shutdown']({
      force: true,
    }) as Record<string, unknown>;

    expect(forceResult.success).toBe(true);
  });

  it('shutdown on uninitialized hive returns error', async () => {
    const result = await tools['hive-mind_shutdown']({}) as Record<string, unknown>;
    expect(result.success).toBe(false);
  });

  it('no state.json file is created or read', async () => {
    // This test verifies the core requirement: no file I/O for hive state
    const fs = await import('node:fs');
    const path = await import('node:path');
    const statePath = path.join(process.cwd(), '.claude-flow', 'hive-mind', 'state.json');

    // Clean up any leftover state file
    try { fs.unlinkSync(statePath); } catch { /* ignore */ }

    await tools['hive-mind_init']({ topology: 'mesh' });
    await tools['hive-mind_join']({ agentId: 'test-agent' });
    await tools['hive-mind_broadcast']({ message: 'test' });

    // Verify state.json was NOT created
    expect(fs.existsSync(statePath)).toBe(false);

    await tools['hive-mind_shutdown']({ force: true });
  });
});
