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

