/**
 * Deterministic 384-dim token-bag embedder for controller tests.
 *
 * ADR-EMB-001 forbids production hash fallbacks, so tests inject their
 * own provider. This one is stateless: the token→slot map is a pure
 * function, so there's no cross-file state leak and no cap on unique
 * token counts (collisions are accepted above DIM — benchmarks with
 * 1000+ fixtures rely on this).
 */

const DIM = 384;

function slotOf(token: string): number {
  let h = 0;
  for (let i = 0; i < token.length; i++) {
    h = ((h << 5) - h + token.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % DIM;
}

export async function deterministicTestEmbedder(text: string): Promise<Float32Array> {
  const out = new Float32Array(DIM);
  const tokens = String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const tok of tokens) {
    out[slotOf(tok)] = 1;
  }
  return out;
}
