/**
 * CLAUDE.md Generator
 *
 * Generates ONLY the MoFlo section to inject into a project's CLAUDE.md.
 * This must be minimal — just enough for Claude to work with moflo.
 * All detailed docs live in .claude/guidance/shipped/moflo.md (copied at install).
 *
 * Principle: we are guests in the user's CLAUDE.md. Keep it small.
 */
import type { InitOptions, ClaudeMdTemplate } from './types.js';
declare const MARKER_START = "<!-- MOFLO:INJECTED:START -->";
declare const MARKER_END = "<!-- MOFLO:INJECTED:END -->";
export { MARKER_START, MARKER_END };
/**
 * Generate the MoFlo section to inject into CLAUDE.md.
 * Template parameter is accepted for backward compatibility but ignored —
 * all templates now produce the same minimal injection.
 */
export declare function generateClaudeMd(_options: InitOptions, _template?: ClaudeMdTemplate): string;
/**
 * Generate minimal CLAUDE.md content (backward-compatible alias).
 */
export declare function generateMinimalClaudeMd(options: InitOptions): string;
/** Available template names for CLI wizard (kept for backward compat, all produce same output) */
export declare const CLAUDE_MD_TEMPLATES: Array<{
    name: ClaudeMdTemplate;
    description: string;
}>;
export default generateClaudeMd;
//# sourceMappingURL=claudemd-generator.d.ts.map