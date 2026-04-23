declare module '@xenova/transformers' {
  export function pipeline(task: string, model: string): Promise<unknown>;
}

declare module 'fastembed' {
  export enum EmbeddingModel {
    AllMiniLML6V2 = 'fast-all-MiniLM-L6-v2',
  }
  export interface InitOptions {
    model: string;
    cacheDir?: string;
    maxLength?: number;
    showDownloadProgress?: boolean;
  }
  export class FlagEmbedding {
    static init(options: InitOptions): Promise<FlagEmbedding>;
    embed(texts: string[], batchSize?: number): AsyncGenerator<number[][], void, unknown>;
    queryEmbed(query: string): Promise<number[]>;
  }
}

declare module 'agentic-flow/embeddings' {
  export function getNeuralSubstrate(config: unknown): Promise<{
    init(): Promise<void>;
    embed(text: string): Promise<number[]>;
    embedBatch(texts: string[]): Promise<number[][]>;
    getModelInfo(): { dimension: number; model: string };
    shutdown(): Promise<void>;
  }>;
  export function listAvailableModels(): Promise<Array<{
    id: string;
    dimension: number;
    size: string;
    quantized: boolean;
    downloaded: boolean;
  }>>;
  export function downloadModel(
    modelId: string,
    targetDir: string,
    onProgress?: (progress: { percent: number; bytesDownloaded: number; totalBytes: number }) => void
  ): Promise<string>;
}
