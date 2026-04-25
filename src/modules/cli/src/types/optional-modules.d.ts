/**
 * Ambient type declarations for optional runtime-imported modules.
 *
 * These modules are dynamically imported at runtime and may or may not
 * be installed. They are NOT bundled — users install them as needed.
 * Declaring them here prevents TS2307 in strict pnpm CI builds where
 * hoisted node_modules are not available.
 */

declare module '@moflo/guidance/analyzer';
declare module '@moflo/guidance/compiler';
declare module '@moflo/guidance/gates';
declare module '@moflo/guidance/retriever';
declare module '@moflo/mcp';
declare module '@moflo/memory';
declare module '@moflo/shared' {
  export interface SystemConfig {
    [key: string]: any;
  }
  export function loadConfig(...args: any[]): any;
}
declare module '@noble/ed25519';

declare module 'pg' {
  const pg: any;
  export default pg;
  export const Pool: any;
  export const Client: any;
}

declare module 'sql.js' {
  const initSqlJs: any;
  export default initSqlJs;
}
