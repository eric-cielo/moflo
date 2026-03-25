# Consumer-Project Path Resolution (bin/ scripts)

## The Problem

MoFlo scripts live in two locations:

1. **`bin/`** — source of truth during development
2. **`.claude/scripts/`** — auto-synced copies in consumer projects

The `session-start-launcher.mjs` auto-sync copies `bin/*.mjs` **verbatim** to
`.claude/scripts/` when moflo is upgraded. This means the same file runs from
different directory depths:

| Location | `__dirname` resolves to |
|----------|------------------------|
| `bin/` (dev) | `<moflo-repo>/bin/` |
| `.claude/scripts/` (consumer) | `<consumer-project>/.claude/scripts/` |

Any `resolve(__dirname, '..')` that works in `bin/` **breaks** in `.claude/scripts/`
(resolves to `.claude/` instead of the project root). This is the #1 recurring
source of "works locally, broken when installed" bugs.

## The Rule

**Every `bin/` script that needs the consumer project root MUST use `findProjectRoot()`
— never `resolve(__dirname, '..')` or `resolve(__dirname, '../..')`.**

```js
function findProjectRoot() {
  let dir = process.cwd();
  const root = resolve(dir, '/');
  while (dir !== root) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}
```

This works regardless of where the script file physically lives because:
- The hook system and `index-all.mjs` always set `cwd` to the project root
- `findProjectRoot()` walks up from `cwd` to find `package.json`

## When `__dirname` IS correct

`__dirname` is still the right choice for locating files **relative to the moflo
package itself** (not the consumer project):

- `mofloRoot = resolve(__dirname, '..')` in `index-guidance.mjs` — locates bundled
  guidance that ships with the npm package. This is correct because it needs the
  moflo package root, not the consumer project root.
- `resolve(__dirname, 'build-embeddings.mjs')` — sibling script in same directory.
  This works because the sync copies both files, preserving their relative positions.

## Resolving sibling scripts

When one script needs to find another (e.g., embedding generation), use a
candidate list that works in all locations:

```js
const candidates = [
  resolve(__dirname, 'build-embeddings.mjs'),                        // sibling (works in both locations)
  resolve(projectRoot, 'node_modules/moflo/bin/build-embeddings.mjs'), // consumer installed
  resolve(projectRoot, '.claude/scripts/build-embeddings.mjs'),       // consumer synced
];
const script = candidates.find(p => existsSync(p));
```

## Checklist for new bin/ scripts

Before merging any new `bin/*.mjs` script:

1. Does it compute `projectRoot`? If yes, verify it uses `findProjectRoot()`.
2. Does it reference sibling scripts? If yes, use the candidate-list pattern.
3. Does it reference `__dirname` for project-root purposes? **Red flag** — fix it.
4. Does it get added to the `scriptFiles` array in `session-start-launcher.mjs`?
   (See feedback memory: `feedback_scriptfiles_sync.md`)

## Files fixed (issue #84)

- `bin/index-all.mjs` — was `resolve(__dirname, '..')`
- `bin/session-start-launcher.mjs` — was `resolve(__dirname, '../..')`
- `bin/hooks.mjs` — was `resolve(__dirname, '../..')`
- `bin/index-patterns.mjs` — hardcoded `node_modules/moflo/bin/` embedding path
