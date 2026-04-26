/**
 * Test fixture for the migration driver — a deterministic `MockBatchEmbedder`
 * that returns `Float32Array` vectors seeded from the input text so assertions
 * can verify "the right text was embedded" without a real ONNX runtime.
 *
 * Lives under __tests__/ to stay out of the published npm package per
 * ADR-EMB-001 (no hash embeddings in production paths).
 */

export class MockBatchEmbedder {
  public calls = 0;
  public lastInputs: string[] = [];
  public history: string[][] = [];

  constructor(
    private readonly dimensions = 8,
    private readonly options: { failAt?: number; miscountAt?: number } = {},
  ) {}

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    this.lastInputs = [...texts];
    this.history.push([...texts]);

    if (this.options.failAt === this.calls) {
      throw new Error(`mock embedder: injected failure on call ${this.calls}`);
    }

    const out: Float32Array[] = texts.map((text) => seedVector(text, this.dimensions));
    if (this.options.miscountAt === this.calls) {
      return out.slice(0, Math.max(0, out.length - 1));
    }
    return out;
  }
}

function seedVector(text: string, dim: number): Float32Array {
  const v = new Float32Array(dim);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  for (let i = 0; i < dim; i++) {
    v[i] = ((h ^ (i * 0x9e3779b1)) >>> 0) / 0xffffffff;
  }
  return v;
}
