/**
 * Workflow Definition Parser
 *
 * Parses YAML/JSON into SpellDefinition objects.
 * NOTE: Parsed output is UNVALIDATED — always call validateSpellDefinition() after parsing.
 */
import { load as yamlLoad, JSON_SCHEMA } from 'js-yaml';
import { sanitizeObjectKeys } from '../core/interpolation.js';
/**
 * Parse a YAML string into a SpellDefinition.
 * @throws if YAML is malformed.
 */
export function parseYaml(content, sourceFile) {
    const raw = yamlLoad(content, { schema: JSON_SCHEMA });
    if (!raw || typeof raw !== 'object') {
        throw new Error(`Invalid workflow YAML${sourceFile ? ` in ${sourceFile}` : ''}: expected an object`);
    }
    const sanitized = sanitizeObjectKeys(raw);
    return {
        definition: sanitized,
        sourceFile,
        format: 'yaml',
    };
}
/**
 * Parse a JSON string into a SpellDefinition.
 * @throws if JSON is malformed.
 */
export function parseJson(content, sourceFile) {
    let raw;
    try {
        raw = JSON.parse(content);
    }
    catch (e) {
        throw new Error(`Invalid workflow JSON${sourceFile ? ` in ${sourceFile}` : ''}: ${e.message}`);
    }
    if (!raw || typeof raw !== 'object') {
        throw new Error(`Invalid workflow JSON${sourceFile ? ` in ${sourceFile}` : ''}: expected an object`);
    }
    const sanitized = sanitizeObjectKeys(raw);
    return {
        definition: sanitized,
        sourceFile,
        format: 'json',
    };
}
/**
 * Parse a workflow file by detecting format from extension or content.
 */
export function parseWorkflow(content, sourceFile) {
    if (sourceFile) {
        const ext = sourceFile.toLowerCase();
        if (ext.endsWith('.json')) {
            return parseJson(content, sourceFile);
        }
        if (ext.endsWith('.yaml') || ext.endsWith('.yml')) {
            return parseYaml(content, sourceFile);
        }
    }
    // Auto-detect: try JSON first (faster), fall back to YAML
    const trimmed = content.trimStart();
    if (trimmed.startsWith('{')) {
        return parseJson(content, sourceFile);
    }
    return parseYaml(content, sourceFile);
}
//# sourceMappingURL=parser.js.map