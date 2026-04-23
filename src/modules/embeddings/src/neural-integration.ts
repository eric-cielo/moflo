/**
 * Neural Substrate Integration
 *
 * Previously wrapped `agentic-flow/embeddings` for semantic drift detection,
 * memory physics, swarm coordination, and coherence monitoring. That dependency
 * was removed in moflo@4.8.80 (see `project_agentdb_removal`), so these APIs
 * now permanently report "unavailable" and the wrapper is a no-op. Public
 * shapes are retained so existing consumers keep compiling.
 *
 * Neural embeddings themselves remain fully supported via the fastembed-backed
 * {@link FastembedEmbeddingService} in this package. This module is only for
 * the agentic-flow neural-substrate extensions (drift / coherence / swarm),
 * which have no replacement wired into moflo yet.
 */

export interface DriftResult {
  distance: number;
  velocity: number;
  acceleration: number;
  trend: 'stable' | 'drifting' | 'accelerating' | 'recovering';
  shouldEscalate: boolean;
  shouldTriggerReasoning: boolean;
}

export interface MemoryEntry {
  id: string;
  embedding: Float32Array;
  content: string;
  strength: number;
  timestamp: number;
  accessCount: number;
  associations: string[];
}

export interface AgentState {
  id: string;
  position: Float32Array;
  velocity: Float32Array;
  attention: Float32Array;
  energy: number;
  lastUpdate: number;
}

export interface CoherenceResult {
  isCoherent: boolean;
  anomalyScore: number;
  stabilityScore: number;
  driftDirection: Float32Array | null;
  warnings: string[];
}

export interface SubstrateHealth {
  memoryCount: number;
  activeAgents: number;
  avgDrift: number;
  avgCoherence: number;
  lastConsolidation: number;
  uptime: number;
}

export interface NeuralSubstrateConfig {
  dimension?: number;
  driftThreshold?: number;
  decayRate?: number;
}

/**
 * No-op neural substrate wrapper. All methods return `null`/`false`/empty
 * values so existing callers continue to work without behavior change.
 */
export class NeuralEmbeddingService {
  private initialized = false;

  constructor(_config: NeuralSubstrateConfig = {}) {}

  async init(): Promise<boolean> {
    this.initialized = true;
    return false;
  }

  isAvailable(): boolean {
    return false;
  }

  async detectDrift(_input: string): Promise<DriftResult | null> {
    return null;
  }

  async setDriftBaseline(_context: string): Promise<void> {}

  async addMemory(_entry: MemoryEntry): Promise<void> {}

  async recallMemory(_query: string, _k?: number): Promise<MemoryEntry[]> {
    return [];
  }

  async checkCoherence(_input: string): Promise<CoherenceResult | null> {
    return null;
  }

  async registerAgent(_state: AgentState): Promise<void> {}

  async updateAgentState(_id: string, _patch: Partial<AgentState>): Promise<void> {}

  async getHealth(): Promise<SubstrateHealth | null> {
    return null;
  }

  async consolidate(): Promise<void> {}
}

export function createNeuralService(config: NeuralSubstrateConfig = {}): NeuralEmbeddingService {
  return new NeuralEmbeddingService(config);
}

/**
 * Neural-substrate features (drift / coherence / swarm) have no runtime since
 * the agentic-flow dependency was removed. Callers should treat neural
 * features as optional and skip them when this returns `false`.
 */
export async function isNeuralAvailable(): Promise<boolean> {
  return false;
}

/**
 * Default catalog of neural embedding models. Since the agentic-flow model
 * registry is no longer bundled, this returns a static fallback list of
 * well-known models so UI rendering keeps working.
 */
export async function listEmbeddingModels(): Promise<Array<{
  id: string;
  dimension: number;
  size: string;
  quantized: boolean;
  downloaded: boolean;
}>> {
  return [
    { id: 'all-MiniLM-L6-v2', dimension: 384, size: '23MB', quantized: false, downloaded: false },
    { id: 'all-mpnet-base-v2', dimension: 768, size: '110MB', quantized: false, downloaded: false },
  ];
}

/**
 * The old `downloadModel` path (via `agentic-flow/embeddings`) is no longer
 * available. Neural models are fetched on-demand by `FastembedEmbeddingService`
 * through the upstream `fastembed` package itself.
 */
export async function downloadEmbeddingModel(
  _modelId: string,
  _targetDir?: string,
  _onProgress?: (progress: { percent: number; bytesDownloaded: number; totalBytes: number }) => void,
): Promise<string> {
  throw new Error(
    'Explicit model downloads are not supported in this build. The ' +
      'fastembed runtime fetches its model automatically on first use.',
  );
}
