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
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { parseWorkflow } from '../schema/parser.js';
import { validateSpellDefinition } from '../schema/validator.js';
// ============================================================================
// Loader
// ============================================================================
const WORKFLOW_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);
/**
 * Load workflow definitions from shipped + user directories.
 * User definitions override shipped ones by workflow name match.
 */
export function loadSpellDefinitions(options = {}) {
    const workflows = new Map();
    const errors = [];
    // Tier 1: Shipped definitions (lowest priority)
    if (options.shippedDir) {
        loadFromDirectory(options.shippedDir, 'shipped', workflows, errors, options);
    }
    // Tier 2: User definitions (override shipped by name)
    if (options.userDirs) {
        for (const dir of options.userDirs) {
            loadFromDirectory(dir, 'user', workflows, errors, options);
        }
    }
    return { workflows, errors };
}
/**
 * Load a single workflow definition by name from the merged registry.
 */
export function loadWorkflowByName(name, options = {}) {
    const { workflows } = loadSpellDefinitions(options);
    return workflows.get(name);
}
// ============================================================================
// Internal
// ============================================================================
function loadFromDirectory(dir, tier, workflows, errors, options) {
    if (!existsSync(dir))
        return;
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return;
    }
    const files = entries.filter(f => WORKFLOW_EXTENSIONS.has(extname(f).toLowerCase()));
    for (const file of files) {
        const filePath = join(dir, file);
        try {
            const content = readFileSync(filePath, 'utf-8');
            const parsed = parseWorkflow(content, filePath);
            if (!options.skipValidation) {
                const validation = validateSpellDefinition(parsed.definition, {
                    knownStepTypes: options.knownStepTypes,
                });
                if (!validation.valid) {
                    errors.push({
                        file: filePath,
                        message: validation.errors.map(e => e.message).join('; '),
                    });
                    continue;
                }
            }
            const key = parsed.definition.name;
            workflows.set(key, {
                definition: parsed.definition,
                sourceFile: filePath,
                tier,
            });
        }
        catch (err) {
            errors.push({
                file: filePath,
                message: err instanceof Error ? err.message : String(err),
            });
        }
    }
}
//# sourceMappingURL=definition-loader.js.map