/**
 * Ambient module declarations for optional peer dependencies.
 * Playwright is loaded dynamically at runtime; this declaration
 * prevents TS2307 when the types package is not installed.
 */
declare module 'playwright' {
  const playwright: unknown;
  export = playwright;
}
