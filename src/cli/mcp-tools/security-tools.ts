/**
 * Security MCP Tools - AIDefence Integration
 *
 * Provides MCP tools for AI manipulation defense:
 * - aidefence_scan: Scan input for threats
 * - aidefence_analyze: Deep analysis of threats
 * - aidefence_stats: Get detection statistics
 * - aidefence_learn: Learn from detection feedback
 * - aidefence_is_safe: Boolean-only quick check
 * - aidefence_has_pii: PII-only check
 *
 * Created with ❤️ by motailz.com
 */

import type { MCPTool, MCPToolResult } from './types.js';
import { tryCreateMofloDbStore } from './aidefence-moflodb-store.js';
import { createAIDefence, type AIDefence, type AIDefenceConfig } from '../aidefence/index.js';

// Lazy-instantiated singleton: first MCP call wires aidefence against the
// MofloDb-backed HNSW vector store when the memory bridge is available, and
// falls back to the in-memory store otherwise.
let aidefenceInstance: AIDefence | null = null;

async function buildAIDefenceConfig(): Promise<AIDefenceConfig> {
  const store = await tryCreateMofloDbStore();
  if (store) {
    console.error('[claude-flow] aidefence: using MofloDb-backed vector store (HNSW)');
    return { enableLearning: true, vectorStore: store };
  }
  console.error('[claude-flow] aidefence: MofloDb bridge unavailable, using in-memory store');
  return { enableLearning: true };
}

async function getAIDefence(): Promise<AIDefence> {
  if (aidefenceInstance) return aidefenceInstance;
  aidefenceInstance = createAIDefence(await buildAIDefenceConfig());
  return aidefenceInstance;
}

/**
 * Scan input for AI manipulation threats
 */
const aidefenceScanTool: MCPTool = {
  name: 'aidefence_scan',
  description: 'Scan input text for AI manipulation threats (prompt injection, jailbreaks, PII). Returns threat assessment with <10ms latency.',
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Text to scan for threats',
      },
      quick: {
        type: 'boolean',
        description: 'Quick scan mode (faster, less detailed)',
        default: false,
      },
    },
    required: ['input'],
  },
  handler: async (args: Record<string, unknown>): Promise<MCPToolResult> => {
    const input = args.input as string;
    const quick = args.quick as boolean;

    try {
      const defender = await getAIDefence();

      if (quick) {
        const result = defender.quickScan(input);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              safe: !result.threat,
              threatDetected: result.threat,
              confidence: result.confidence,
              mode: 'quick',
            }, null, 2),
          }],
        };
      }

      const result = await defender.detect(input);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            safe: result.safe,
            threats: result.threats.map(t => ({
              type: t.type,
              severity: t.severity,
              confidence: t.confidence,
              description: t.description,
            })),
            piiFound: result.piiFound,
            detectionTimeMs: result.detectionTimeMs,
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: String(error) }),
        }],
        isError: true,
      };
    }
  },
};

/**
 * Deep analysis of specific threat
 */
const aidefenceAnalyzeTool: MCPTool = {
  name: 'aidefence_analyze',
  description: 'Deep analysis of input for specific threat types with similar pattern search and mitigation recommendations.',
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Text to analyze',
      },
      searchSimilar: {
        type: 'boolean',
        description: 'Search for similar known threats',
        default: true,
      },
      k: {
        type: 'number',
        description: 'Number of similar patterns to retrieve',
        default: 5,
      },
    },
    required: ['input'],
  },
  handler: async (args: Record<string, unknown>): Promise<MCPToolResult> => {
    const input = args.input as string;
    const searchSimilar = args.searchSimilar !== false;
    const k = (args.k as number) || 5;

    try {
      const defender = await getAIDefence();
      const result = await defender.detect(input);

      // Mitigation lookups and similar-threat search share no data dependency,
      // so fan them out together (#607).
      const [mitigations, similar] = await Promise.all([
        Promise.all(
          result.threats.map(async (threat) => {
            const mitigation = await defender.getBestMitigation(
              threat.type as Parameters<typeof defender.getBestMitigation>[0]
            );
            return mitigation
              ? { threatType: threat.type, strategy: mitigation.strategy, effectiveness: mitigation.effectiveness }
              : null;
          })
        ),
        searchSimilar ? defender.searchSimilarThreats(input, { k }) : Promise.resolve([]),
      ]);

      const analysis: Record<string, unknown> = {
        detection: {
          safe: result.safe,
          threats: result.threats,
          piiFound: result.piiFound,
        },
        mitigations: mitigations.filter((m): m is NonNullable<typeof m> => m !== null),
        similarPatterns: searchSimilar
          ? similar.map(p => ({ pattern: p.pattern, type: p.type, effectiveness: p.effectiveness }))
          : [],
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(analysis, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: String(error) }),
        }],
        isError: true,
      };
    }
  },
};

/**
 * Get detection statistics
 */
const aidefenceStatsTool: MCPTool = {
  name: 'aidefence_stats',
  description: 'Get AIDefence detection and learning statistics.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (): Promise<MCPToolResult> => {
    try {
      const defender = await getAIDefence();
      const stats = await defender.getStats();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            detectionCount: stats.detectionCount,
            avgDetectionTimeMs: stats.avgDetectionTimeMs,
            learnedPatterns: stats.learnedPatterns,
            mitigationStrategies: stats.mitigationStrategies,
            avgMitigationEffectiveness: stats.avgMitigationEffectiveness,
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: String(error) }),
        }],
        isError: true,
      };
    }
  },
};

/**
 * Record detection feedback for learning
 */
const aidefenceLearnTool: MCPTool = {
  name: 'aidefence_learn',
  description: 'Record detection feedback for pattern learning. Improves future detection accuracy.',
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Original input that was scanned',
      },
      wasAccurate: {
        type: 'boolean',
        description: 'Whether the detection was accurate',
      },
      verdict: {
        type: 'string',
        description: 'User verdict or correction',
      },
      threatType: {
        type: 'string',
        description: 'Threat type for mitigation recording',
      },
      mitigationStrategy: {
        type: 'string',
        description: 'Mitigation strategy used',
        enum: ['block', 'sanitize', 'warn', 'log', 'escalate', 'transform', 'redirect'],
      },
      mitigationSuccess: {
        type: 'boolean',
        description: 'Whether the mitigation was successful',
      },
    },
    required: ['input', 'wasAccurate'],
  },
  handler: async (args: Record<string, unknown>): Promise<MCPToolResult> => {
    const input = args.input as string;
    const wasAccurate = args.wasAccurate as boolean;
    const verdict = args.verdict as string | undefined;
    const threatType = args.threatType as string | undefined;
    const mitigationStrategy = args.mitigationStrategy as string | undefined;
    const mitigationSuccess = args.mitigationSuccess as boolean | undefined;

    try {
      const defender = await getAIDefence();

      // Re-detect to get result for learning
      const result = await defender.detect(input);

      // Learn from detection
      await defender.learnFromDetection(input, result, {
        wasAccurate,
        userVerdict: verdict,
      });

      // Record mitigation if provided
      if (threatType && mitigationStrategy && mitigationSuccess !== undefined) {
        await defender.recordMitigation(
          threatType as Parameters<typeof defender.recordMitigation>[0],
          mitigationStrategy as Parameters<typeof defender.recordMitigation>[1],
          mitigationSuccess
        );
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'Feedback recorded for pattern learning',
            learnedFrom: {
              input: input.slice(0, 50) + (input.length > 50 ? '...' : ''),
              wasAccurate,
              threatCount: result.threats.length,
            },
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: String(error) }),
        }],
        isError: true,
      };
    }
  },
};

/**
 * Check if input is safe (simple boolean check)
 */
const aidefenceIsSafeTool: MCPTool = {
  name: 'aidefence_is_safe',
  description: 'Quick boolean check if input is safe. Fastest option for simple validation.',
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Text to check',
      },
    },
    required: ['input'],
  },
  handler: async (args: Record<string, unknown>): Promise<MCPToolResult> => {
    const input = args.input as string;

    try {
      const defender = await getAIDefence();
      const result = defender.quickScan(input);
      const safe = !result.threat;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ safe }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: String(error) }),
        }],
        isError: true,
      };
    }
  },
};

/**
 * Check for PII in input
 */
const aidefenceHasPIITool: MCPTool = {
  name: 'aidefence_has_pii',
  description: 'Check if input contains PII (emails, SSNs, API keys, passwords, etc.).',
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Text to check for PII',
      },
    },
    required: ['input'],
  },
  handler: async (args: Record<string, unknown>): Promise<MCPToolResult> => {
    const input = args.input as string;

    try {
      const defender = await getAIDefence();
      const hasPII = defender.hasPII(input);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ hasPII }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: String(error) }),
        }],
        isError: true,
      };
    }
  },
};

/**
 * Export all security tools
 */
export const securityTools: MCPTool[] = [
  aidefenceScanTool,
  aidefenceAnalyzeTool,
  aidefenceStatsTool,
  aidefenceLearnTool,
  aidefenceIsSafeTool,
  aidefenceHasPIITool,
];

export default securityTools;
