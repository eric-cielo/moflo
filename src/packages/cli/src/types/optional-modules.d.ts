/**
 * Ambient type declarations for optional runtime-imported modules.
 *
 * These modules are dynamically imported at runtime and may or may not
 * be installed. They are NOT bundled — users install them as needed.
 * Declaring them here prevents TS2307 in strict pnpm CI builds where
 * hoisted node_modules are not available.
 */

declare module '@claude-flow/aidefence' {
  export function createAIDefence(...args: any[]): any;
  export function isSafe(...args: any[]): any;
  const _default: any;
  export default _default;
}
declare module '@claude-flow/embeddings';
declare module '@claude-flow/guidance/analyzer';
declare module '@claude-flow/guidance/compiler';
declare module '@claude-flow/guidance/gates';
declare module '@claude-flow/guidance/retriever';
declare module '@claude-flow/mcp';
declare module '@claude-flow/memory';
declare module '@claude-flow/shared' {
  export interface SystemConfig {
    [key: string]: any;
  }
  export function loadConfig(...args: any[]): any;
}
declare module '@noble/ed25519';

declare module 'pg' {
  const pg: any;
  export default pg;
  export const Pool: any;
  export const Client: any;
}

declare module 'sql.js' {
  const initSqlJs: any;
  export default initSqlJs;
}

declare module 'agentic-flow' {
  export const reasoningbank: any;
}

declare module 'agentic-flow/reasoningbank' {
  export const VERSION: string;
  export const PAPER_URL: string;
  export class ReflexionMemory { constructor(...args: any[]); }
  export class SkillLibrary { constructor(...args: any[]); }
  export class CausalMemoryGraph { constructor(...args: any[]); }
  export class HybridReasoningBank { constructor(...args: any[]); }
  export class AdvancedMemorySystem { constructor(...args: any[]); }
  export class EmbeddingService { constructor(...args: any[]); }
  export class NightlyLearner { constructor(...args: any[]); }
  export function initialize(...args: any[]): Promise<any>;
  export function retrieveMemories(query: string, opts?: any): Promise<any[]>;
  export function formatMemoriesForPrompt(memories: any[]): string;
  export function judgeTrajectory(...args: any[]): any;
  export function distillMemories(...args: any[]): any;
  export function consolidate(...args: any[]): any;
  export function shouldConsolidate(...args: any[]): boolean;
  export function computeEmbedding(text: string): Promise<number[]>;
  export function cosineSimilarity(a: number[], b: number[]): number;
  export function clearEmbeddingCache(): void;
  export function containsPII(text: string): boolean;
  export function scrubPII(text: string): string;
  export function scrubMemory(text: string): string;
  export function mmrSelection(items: any[], query: any, opts?: any): any[];
  export function runTask(...args: any[]): Promise<any>;
  export function loadConfig(): any;
  export const db: any;
  export function CausalRecall(...args: any[]): any;
  export function mattsParallel(...args: any[]): any;
  export function mattsSequential(...args: any[]): any;
}

declare module 'agentic-flow/router' {
  export class ModelRouter { constructor(...args: any[]); route(prompt: string, opts?: any): Promise<any>; getStats(): any; }
  export class AnthropicProvider { constructor(...args: any[]); }
  export class GeminiProvider { constructor(...args: any[]); }
  export class OpenRouterProvider { constructor(...args: any[]); }
  export class ONNXLocalProvider { constructor(...args: any[]); }
  export const CLAUDE_MODELS: any;
  export function getModelName(id: string): string;
  export function listModels(): any[];
  export function mapModelId(id: string): string;
}

declare module 'agentic-flow/orchestration' {
  export function createOrchestrator(...args: any[]): any;
  export function createOrchestrationClient(...args: any[]): any;
  export function seedMemory(...args: any[]): Promise<any>;
  export function searchMemory(...args: any[]): Promise<any>;
  export function harvestMemory(...args: any[]): Promise<any>;
  export function recordLearning(...args: any[]): Promise<any>;
  export function getRunStatus(id: string): Promise<any>;
  export function getRunArtifacts(id: string): Promise<any>;
  export function cancelRun(id: string): Promise<any>;
}

declare module 'agentic-flow/agent-booster' {
  export class EnhancedAgentBooster { constructor(...args: any[]); }
  export function getEnhancedBooster(...args: any[]): any;
  export function enhancedApply(opts: { code: string; edit: string; language?: string }): Promise<{ confidence: number; output: string }>;
  export function benchmark(...args: any[]): Promise<any>;
}

declare module 'agentic-flow/intelligence/agent-booster-enhanced' {
  export class EnhancedAgentBooster { constructor(...args: any[]); }
  export function getEnhancedBooster(...args: any[]): any;
  export function enhancedApply(opts: { code: string; edit: string; language?: string }): Promise<{ confidence: number; output: string }>;
  export function benchmark(...args: any[]): Promise<any>;
}

declare module 'agentic-flow/sdk' {
  const sdk: any;
  export default sdk;
}

declare module 'agentic-flow/security' {
  const security: any;
  export default security;
}

declare module 'agentic-flow/transport/quic' {
  const quic: any;
  export default quic;
}

declare module 'ruvector' {
  const ruvector: any;
  export default ruvector;
  export const VectorDB: any;
  export const VectorDb: any;
  export function isWasm(): boolean;
}

declare module '@ruvector/core' {
  const core: any;
  export default core;
}

declare module '@xenova/transformers' {
  const transformers: any;
  export default transformers;
  export const pipeline: any;
  export const env: any;
}
