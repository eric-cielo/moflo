/**
 * Security Module
 *
 * Shared security utilities for V3 MoFlo.
 *
 * @module v3/shared/security
 */

// Unique-ID minting lives in `shared/utils/id.ts`, not here. `secure-random.ts`
// re-exported fifteen ID helpers from this barrel and not one of them ever had
// an importer, while ~38 call sites went on minting IDs with `Math.random()`.
// It was deleted in #1423 rather than adopted: its per-domain exports
// (`generateAgentId`, `generateTaskId`, …) were the sprawl, and one of them
// shadowed the live `generateMemoryId` in `memory/types.ts`.

// Input validation
export {
  validateInput,
  sanitizeString,
  validatePath,
  validateCommand,
  validateTags,
  isValidIdentifier,
  escapeForSql,
  type ValidationResult,
  type ValidationOptions,
} from './input-validation.js';
