/**
 * Lazy loader for optional SDK dependencies.
 *
 * Connectors wrapping truly optional SDKs (imapflow, mailparser) declare them
 * as `peerDependenciesMeta.optional` so consumers that don't use the connector
 * don't need to install them. The `@modelcontextprotocol/sdk` is a hard
 * `dependency` because the MCP connector is a headline feature, but it is still
 * routed through this helper so a corrupted install still yields an actionable
 * message instead of a raw MODULE_NOT_FOUND.
 *
 * Every specifier passed to `loadOptional()` MUST be declared in package.json
 * (dependencies, optionalDependencies, or peerDependenciesMeta). The drift
 * guard at `src/cli/__tests__/spells/connectors/optional-import-declared.test.ts`
 * enforces this — it walks shipped connectors, extracts every specifier, and
 * fails the build if one is undeclared.
 */

const moduleCache = new Map<string, Promise<unknown>>();

function isModuleNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

/**
 * Load an optional module by specifier. The result is memoized per specifier
 * for the process lifetime, so repeated calls are free after the first.
 *
 * @param specifier  The bare module specifier to `import()`
 * @param installMsg Actionable install instruction shown to the user if the
 *                   module is absent (e.g. `"Run: npm i imapflow mailparser"`)
 */
export function loadOptional<T>(specifier: string, installMsg: string): Promise<T> {
  const cached = moduleCache.get(specifier);
  if (cached) return cached as Promise<T>;

  const promise = (async () => {
    try {
      return await import(/* @vite-ignore */ specifier);
    } catch (err) {
      if (isModuleNotFound(err)) {
        throw new Error(installMsg);
      }
      throw err;
    }
  })();

  moduleCache.set(specifier, promise);
  // If the import fails, drop the rejection from the cache so callers can
  // retry (e.g. after the user installs the dep) without hitting a cached
  // error forever.
  promise.catch(() => moduleCache.delete(specifier));
  return promise as Promise<T>;
}

/** Clear the module cache. Exported for tests that simulate a missing dep. */
export function __resetOptionalImportCache(): void {
  moduleCache.clear();
}
