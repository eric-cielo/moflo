/**
 * Workflow Definition Loader
 *
 * Two-tier definition system:
 *   Tier 1 — Shipped definitions bundled with moflo (read-only defaults)
 *   Tier 2 — User definitions at configurable project path (override by name)
 *
 * Resolution: load shipped first, then user. User definitions with the same
 * name replace shipped ones; new names are additive.
 */
import type { SpellDefinition } from '../types/workflow-definition.types.js';
export interface LoaderOptions {
    /** Shipped definitions directory (absolute path). */
    readonly shippedDir?: string;
    /** User definition directories (absolute paths), searched in order. */
    readonly userDirs?: readonly string[];
    /** Step types known to the registry (passed to validator). */
    readonly knownStepTypes?: readonly string[];
    /** If true, skip validation (useful for testing). */
    readonly skipValidation?: boolean;
}
export interface LoadedWorkflow {
    readonly definition: SpellDefinition;
    readonly sourceFile: string;
    readonly tier: 'shipped' | 'user';
}
export interface LoadResult {
    readonly workflows: Map<string, LoadedWorkflow>;
    readonly errors: readonly LoadError[];
}
export interface LoadError {
    readonly file: string;
    readonly message: string;
}
/**
 * Load workflow definitions from shipped + user directories.
 * User definitions override shipped ones by workflow name match.
 */
export declare function loadSpellDefinitions(options?: LoaderOptions): LoadResult;
/**
 * Load a single workflow definition by name from the merged registry.
 */
export declare function loadWorkflowByName(name: string, options?: LoaderOptions): LoadedWorkflow | undefined;
//# sourceMappingURL=definition-loader.d.ts.map