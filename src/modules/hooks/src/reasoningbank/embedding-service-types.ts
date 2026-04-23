/** Embedding-service contract shared by the prod and mock implementations. */

export interface IEmbeddingService {
  embed(text: string): Promise<Float32Array>;
}
