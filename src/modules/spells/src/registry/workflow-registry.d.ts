/**
 * Workflow Registry
 *
 * Maps workflow names AND abbreviations to loaded workflow definitions.
 * Wraps the definition-loader with abbreviation-based lookup, collision
 * detection, and list/info capabilities.
 *
 * Story #105: Workflow Registry + /flo -wf Integration
 */
import type { LoaderOptions, LoadedWorkflow, LoadError } from '../loaders/definition-loader.js';
import type { ArgumentDefinition } from '../types/workflow-definition.types.js';
export interface RegistryOptions extends LoaderOptions {
    /** Additional directories to scan (convenience alias for userDirs). */
    readonly extraDirs?: readonly string[];
}
export interface RegistryResult {
    readonly workflows: ReadonlyMap<string, LoadedWorkflow>;
    readonly abbreviations: ReadonlyMap<string, string>;
    readonly collisions: readonly AbbreviationCollision[];
    readonly errors: readonly LoadError[];
}
export interface AbbreviationCollision {
    readonly abbreviation: string;
    readonly workflows: readonly string[];
}
export interface WorkflowInfo {
    readonly name: string;
    readonly abbreviation?: string;
    readonly description?: string;
    readonly version?: string;
    readonly sourceFile: string;
    readonly tier: 'shipped' | 'user';
    readonly arguments: Record<string, ArgumentDefinition>;
    readonly stepCount: number;
    readonly stepTypes: readonly string[];
}
export interface WorkflowListEntry {
    readonly name: string;
    readonly abbreviation?: string;
    readonly description?: string;
    readonly tier: 'shipped' | 'user';
}
export declare class Grimoire {
    private readonly loaderOptions;
    private cachedResult;
    constructor(options?: RegistryOptions);
    /**
     * Load and index all workflow definitions.
     * Builds the abbreviation map and detects collisions.
     */
    load(): RegistryResult;
    /**
     * Resolve a query (abbreviation OR full name) to a loaded workflow.
     * Returns undefined if no match is found.
     */
    resolve(query: string): LoadedWorkflow | undefined;
    /**
     * List all registered workflows (name, abbreviation, description, tier).
     */
    list(): readonly WorkflowListEntry[];
    /**
     * Get detailed info about a specific workflow (by name or abbreviation).
     */
    info(query: string): WorkflowInfo | undefined;
    /**
     * Invalidate the cached load result, forcing a re-scan on next access.
     */
    invalidate(): void;
}
//# sourceMappingURL=workflow-registry.d.ts.map