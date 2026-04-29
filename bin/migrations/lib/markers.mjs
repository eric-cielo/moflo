/**
 * Shared tag markers used across the knowledge → learnings migration pipeline.
 *
 * @module bin/migrations/lib/markers
 */

/** Tag stamped on every learnings row that was migrated from the deprecated
 *  knowledge namespace. The purge migration uses this to confirm a counterpart
 *  exists before hard-deleting the source row, so a typo here silently breaks
 *  the entire pipeline. */
export const MIGRATED_FROM_KNOWLEDGE = 'migratedFrom:knowledge';
