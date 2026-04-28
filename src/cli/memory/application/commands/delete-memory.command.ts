/**
 * Delete Memory Command - Application Layer (CQRS)
 *
 * Hard-deletes memory entries. Soft-delete was retired in story #728 because
 * tombstones were write-only (no code path ever restored a `status='deleted'`
 * row) and bloated the DB indefinitely. The legitimate "keep but hide" case
 * is `archived` — see `MemoryEntry.archive()` / `restore()`.
 *
 * @module v3/memory/application/commands
 */

import { IMemoryRepository } from '../../domain/repositories/memory-repository.interface.js';

/**
 * Delete Memory Command Input
 */
export interface DeleteMemoryInput {
  id?: string;
  namespace?: string;
  key?: string;
}

/**
 * Delete Memory Command Result
 */
export interface DeleteMemoryResult {
  success: boolean;
  deleted: boolean;
  entryId?: string;
}

/**
 * Delete Memory Command Handler
 */
export class DeleteMemoryCommandHandler {
  constructor(private readonly repository: IMemoryRepository) {}

  async execute(input: DeleteMemoryInput): Promise<DeleteMemoryResult> {
    let entryId: string | undefined;

    // Find entry by ID or by namespace:key
    if (input.id) {
      entryId = input.id;
    } else if (input.namespace && input.key) {
      const entry = await this.repository.findByKey(input.namespace, input.key);
      entryId = entry?.id;
    }

    if (!entryId) {
      return { success: false, deleted: false };
    }

    const deleted = await this.repository.delete(entryId);
    return { success: true, deleted, entryId };
  }
}

/**
 * Bulk Delete Command Input
 */
export interface BulkDeleteMemoryInput {
  ids?: string[];
  namespace?: string;
  olderThan?: Date;
}

/**
 * Bulk Delete Command Result
 */
export interface BulkDeleteMemoryResult {
  success: boolean;
  deletedCount: number;
  failedCount: number;
  errors: Array<{ id: string; error: string }>;
}

/**
 * Bulk Delete Memory Command Handler
 */
export class BulkDeleteMemoryCommandHandler {
  constructor(private readonly repository: IMemoryRepository) {}

  async execute(input: BulkDeleteMemoryInput): Promise<BulkDeleteMemoryResult> {
    let idsToDelete: string[] = [];

    if (input.ids) {
      idsToDelete = input.ids;
    } else if (input.namespace) {
      const entries = await this.repository.findByNamespace(input.namespace);
      idsToDelete = entries
        .filter((e) => !input.olderThan || e.createdAt < input.olderThan)
        .map((e) => e.id);
    }

    if (idsToDelete.length === 0) {
      return { success: true, deletedCount: 0, failedCount: 0, errors: [] };
    }

    const result = await this.repository.deleteMany(idsToDelete);
    return {
      success: result.failed === 0,
      deletedCount: result.success,
      failedCount: result.failed,
      errors: result.errors,
    };
  }
}
