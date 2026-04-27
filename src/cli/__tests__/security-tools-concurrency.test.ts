/**
 * Concurrency test for security MCP handler.
 *
 * Guards the perf fix from #607: aidefence_analyze must run getBestMitigation
 * lookups in parallel, not sequentially.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../mcp-tools/aidefence-moflodb-store.js', () => ({
  tryCreateMofloDbStore: vi.fn(async () => null),
}));

const mockDetect = vi.fn();
const mockGetBestMitigation = vi.fn();
const mockSearchSimilarThreats = vi.fn(async () => []);

vi.mock('../aidefence/index.js', () => ({
  createAIDefence: vi.fn(() => ({
    detect: mockDetect,
    getBestMitigation: mockGetBestMitigation,
    searchSimilarThreats: mockSearchSimilarThreats,
  })),
}));

import { securityTools } from '../mcp-tools/security-tools.js';

const aidefenceAnalyzeTool = securityTools.find(t => t.name === 'aidefence_analyze');

describe('aidefence_analyze concurrency', () => {
  beforeEach(() => {
    mockDetect.mockReset();
    mockGetBestMitigation.mockReset();
    mockSearchSimilarThreats.mockClear();
  });

  it('runs getBestMitigation lookups in parallel', async () => {
    expect(aidefenceAnalyzeTool).toBeDefined();
    const threatTypes = [
      'prompt_injection',
      'jailbreak',
      'data_exfiltration',
      'context_manipulation',
      'social_engineering',
    ];
    const threats = threatTypes.map(type => ({
      type,
      severity: 'high',
      confidence: 0.9,
      description: 'test',
    }));
    mockDetect.mockResolvedValue({
      safe: false,
      threats,
      piiFound: false,
      detectionTimeMs: 1,
    });
    const delayMs = 50;
    mockGetBestMitigation.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return { strategy: 'block', effectiveness: 0.9 };
    });

    const start = performance.now();
    const result = await aidefenceAnalyzeTool!.handler({ input: 'test', searchSimilar: false });
    const elapsed = performance.now() - start;

    // Sequential would be 5 × 50ms = 250ms; parallel should land near 50ms.
    // Use a generous bound (half of sequential) to keep this stable on busy CI.
    expect(elapsed).toBeLessThan((threatTypes.length * delayMs) / 2);

    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.mitigations).toHaveLength(threatTypes.length);
    expect(payload.mitigations.map((m: { threatType: string }) => m.threatType)).toEqual(threatTypes);
  });

  it('filters out threats with no available mitigation', async () => {
    mockDetect.mockResolvedValue({
      safe: false,
      threats: [
        { type: 'prompt_injection', severity: 'high', confidence: 0.9, description: '' },
        { type: 'jailbreak', severity: 'high', confidence: 0.9, description: '' },
        { type: 'social_engineering', severity: 'high', confidence: 0.9, description: '' },
      ],
      piiFound: false,
      detectionTimeMs: 1,
    });
    mockGetBestMitigation.mockImplementation(async (type: string) => {
      if (type === 'jailbreak') return null;
      return { strategy: 'block', effectiveness: 0.8 };
    });

    const result = await aidefenceAnalyzeTool!.handler({ input: 'test', searchSimilar: false });
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.mitigations).toHaveLength(2);
    expect(payload.mitigations.map((m: { threatType: string }) => m.threatType)).toEqual([
      'prompt_injection',
      'social_engineering',
    ]);
  });
});
