/**
 * Thin re-export so callers under `cli/src/services/` keep their existing
 * import path. The canonical helper lives in `cli/src/shared/utils/` (#564).
 *
 * @module moflo/services/atomic-file-write
 */

export {
  atomicWriteFileSync,
  type AtomicWriteFs,
} from '../shared/utils/atomic-file-write.js';
