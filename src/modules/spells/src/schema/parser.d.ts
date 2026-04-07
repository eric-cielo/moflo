/**
 * Workflow Definition Parser
 *
 * Parses YAML/JSON into SpellDefinition objects.
 * NOTE: Parsed output is UNVALIDATED — always call validateSpellDefinition() after parsing.
 */
import type { ParsedWorkflow } from '../types/workflow-definition.types.js';
/**
 * Parse a YAML string into a SpellDefinition.
 * @throws if YAML is malformed.
 */
export declare function parseYaml(content: string, sourceFile?: string): ParsedWorkflow;
/**
 * Parse a JSON string into a SpellDefinition.
 * @throws if JSON is malformed.
 */
export declare function parseJson(content: string, sourceFile?: string): ParsedWorkflow;
/**
 * Parse a workflow file by detecting format from extension or content.
 */
export declare function parseWorkflow(content: string, sourceFile?: string): ParsedWorkflow;
//# sourceMappingURL=parser.d.ts.map