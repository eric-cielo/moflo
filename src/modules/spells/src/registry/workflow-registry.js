/**
 * Workflow Registry
 *
 * Maps workflow names AND abbreviations to loaded workflow definitions.
 * Wraps the definition-loader with abbreviation-based lookup, collision
 * detection, and list/info capabilities.
 *
 * Story #105: Workflow Registry + /flo -wf Integration
 */
import { loadSpellDefinitions } from '../loaders/definition-loader.js';
// ============================================================================
// Registry
// ============================================================================
export class Grimoire {
    loaderOptions;
    cachedResult = null;
    constructor(options = {}) {
        const userDirs = [
            ...(options.userDirs ?? []),
            ...(options.extraDirs ?? []),
        ];
        this.loaderOptions = {
            shippedDir: options.shippedDir,
            userDirs,
            knownStepTypes: options.knownStepTypes,
            skipValidation: options.skipValidation,
        };
    }
    /**
     * Load and index all workflow definitions.
     * Builds the abbreviation map and detects collisions.
     */
    load() {
        const { workflows, errors } = loadSpellDefinitions(this.loaderOptions);
        const abbreviations = new Map();
        const collisionMap = new Map();
        for (const [name, loaded] of workflows) {
            const abbr = loaded.definition.abbreviation;
            if (!abbr)
                continue;
            if (collisionMap.has(abbr)) {
                collisionMap.get(abbr).push(name);
            }
            else if (abbreviations.has(abbr)) {
                const existing = abbreviations.get(abbr);
                collisionMap.set(abbr, [existing, name]);
                abbreviations.delete(abbr);
            }
            else {
                abbreviations.set(abbr, name);
            }
        }
        const collisions = [];
        for (const [abbreviation, names] of collisionMap) {
            collisions.push({ abbreviation, workflows: names });
        }
        this.cachedResult = { workflows, abbreviations, collisions, errors };
        return this.cachedResult;
    }
    /**
     * Resolve a query (abbreviation OR full name) to a loaded workflow.
     * Returns undefined if no match is found.
     */
    resolve(query) {
        const result = this.cachedResult ?? this.load();
        // Try full name first
        const byName = result.workflows.get(query);
        if (byName)
            return byName;
        // Try abbreviation
        const fullName = result.abbreviations.get(query);
        if (fullName)
            return result.workflows.get(fullName);
        return undefined;
    }
    /**
     * List all registered workflows (name, abbreviation, description, tier).
     */
    list() {
        const result = this.cachedResult ?? this.load();
        const entries = [];
        for (const [, loaded] of result.workflows) {
            entries.push({
                name: loaded.definition.name,
                abbreviation: loaded.definition.abbreviation,
                description: loaded.definition.description,
                tier: loaded.tier,
            });
        }
        return entries.sort((a, b) => a.name.localeCompare(b.name));
    }
    /**
     * Get detailed info about a specific workflow (by name or abbreviation).
     */
    info(query) {
        const loaded = this.resolve(query);
        if (!loaded)
            return undefined;
        const def = loaded.definition;
        const { count, types } = analyzeSteps(def.steps);
        return {
            name: def.name,
            abbreviation: def.abbreviation,
            description: def.description,
            version: def.version,
            sourceFile: loaded.sourceFile,
            tier: loaded.tier,
            arguments: def.arguments ?? {},
            stepCount: count,
            stepTypes: [...types].sort(),
        };
    }
    /**
     * Invalidate the cached load result, forcing a re-scan on next access.
     */
    invalidate() {
        this.cachedResult = null;
    }
}
// ============================================================================
// Helpers
// ============================================================================
/** Single-pass step analysis: counts steps and collects unique types. */
function analyzeSteps(steps, types = new Set()) {
    let count = 0;
    for (const step of steps) {
        count++;
        types.add(step.type);
        if (step.steps) {
            count += analyzeSteps(step.steps, types).count;
        }
    }
    return { count, types };
}
//# sourceMappingURL=workflow-registry.js.map