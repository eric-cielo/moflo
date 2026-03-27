/**
 * Memory Initializer Tests
 *
 * Verifies key exports exist and basic function signatures.
 * All database calls are mocked — no real sql.js or filesystem access.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock fs so nothing touches the real filesystem
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue(Buffer.alloc(0)),
    statSync: vi.fn().mockReturnValue({ size: 1024 }),
  };
});

// Mock the moflo-require dynamic import helper
vi.mock('../../src/services/moflo-require.js', () => ({
  mofloImport: vi.fn().mockRejectedValue(new Error('mocked')),
}));

// Mock the memory-bridge so getBridge() returns null
vi.mock('../../src/memory/memory-bridge.js', () => {
  throw new Error('mocked');
});

describe('memory-initializer exports', () => {
  // Use dynamic import so mocks are in place before module loads
  let mod: typeof import('../../src/memory/memory-initializer.js');

  it('should load the module without error', async () => {
    mod = await import('../../src/memory/memory-initializer.js');
    expect(mod).toBeDefined();
  });

  // ===========================================================================
  // Key Exports
  // ===========================================================================
  describe('exported functions', () => {
    it('should export initializeMemoryDatabase', async () => {
      mod = await import('../../src/memory/memory-initializer.js');
      expect(typeof mod.initializeMemoryDatabase).toBe('function');
    });

    it('should export generateEmbedding', async () => {
      mod = await import('../../src/memory/memory-initializer.js');
      expect(typeof mod.generateEmbedding).toBe('function');
    });

    it('should export getHNSWStatus', async () => {
      mod = await import('../../src/memory/memory-initializer.js');
      expect(typeof mod.getHNSWStatus).toBe('function');
    });

    it('should export checkMemoryInitialization', async () => {
      mod = await import('../../src/memory/memory-initializer.js');
      expect(typeof mod.checkMemoryInitialization).toBe('function');
    });

    it('should export storeEntry', async () => {
      mod = await import('../../src/memory/memory-initializer.js');
      expect(typeof mod.storeEntry).toBe('function');
    });

    it('should export searchEntries', async () => {
      mod = await import('../../src/memory/memory-initializer.js');
      expect(typeof mod.searchEntries).toBe('function');
    });

    it('should export listEntries', async () => {
      mod = await import('../../src/memory/memory-initializer.js');
      expect(typeof mod.listEntries).toBe('function');
    });

    it('should export getEntry', async () => {
      mod = await import('../../src/memory/memory-initializer.js');
      expect(typeof mod.getEntry).toBe('function');
    });

    it('should export deleteEntry', async () => {
      mod = await import('../../src/memory/memory-initializer.js');
      expect(typeof mod.deleteEntry).toBe('function');
    });

    it('should export MEMORY_SCHEMA_V3 string', async () => {
      mod = await import('../../src/memory/memory-initializer.js');
      expect(typeof mod.MEMORY_SCHEMA_V3).toBe('string');
      expect(mod.MEMORY_SCHEMA_V3).toContain('memory_entries');
    });
  });

  // ===========================================================================
  // Utility Exports
  // ===========================================================================
  describe('utility exports', () => {
    it('should export quantizeInt8', async () => {
      mod = await import('../../src/memory/memory-initializer.js');
      expect(typeof mod.quantizeInt8).toBe('function');
    });

    it('should export dequantizeInt8', async () => {
      mod = await import('../../src/memory/memory-initializer.js');
      expect(typeof mod.dequantizeInt8).toBe('function');
    });

    it('should export batchCosineSim', async () => {
      mod = await import('../../src/memory/memory-initializer.js');
      expect(typeof mod.batchCosineSim).toBe('function');
    });

    it('should export flashAttentionSearch', async () => {
      mod = await import('../../src/memory/memory-initializer.js');
      expect(typeof mod.flashAttentionSearch).toBe('function');
    });
  });

  // ===========================================================================
  // getHNSWStatus (pure function, no DB needed)
  // ===========================================================================
  describe('getHNSWStatus', () => {
    it('should return a status object with expected fields', async () => {
      mod = await import('../../src/memory/memory-initializer.js');
      const status = mod.getHNSWStatus();
      expect(status).toHaveProperty('initialized');
      expect(status).toHaveProperty('entryCount');
      expect(typeof status.initialized).toBe('boolean');
    });
  });

  // ===========================================================================
  // quantizeInt8 (pure computation, no mocks needed)
  // ===========================================================================
  describe('quantizeInt8', () => {
    it('should quantize a float array to Int8 with scale/offset', async () => {
      mod = await import('../../src/memory/memory-initializer.js');
      const embedding = [0.1, 0.5, -0.3, 0.9, -0.8];
      const result = mod.quantizeInt8(embedding);
      expect(result).toHaveProperty('quantized');
      expect(result).toHaveProperty('scale');
      expect(result).toHaveProperty('zeroPoint');
      expect(result.quantized).toBeInstanceOf(Int8Array);
      expect(result.quantized.length).toBe(5);
    });
  });
});
