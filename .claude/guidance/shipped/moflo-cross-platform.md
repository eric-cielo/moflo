# Cross-Platform Compatibility Rules

**Purpose:** Ensure all moflo code works on Linux, macOS, and Windows without platform-specific failures. Apply these rules to every code change — new files, edits, and reviews.

---

## Path Handling

**Never use hardcoded path separators or drive letters.** All path construction MUST use `path.join()`, `path.resolve()`, or forward slashes.

| Pattern | Status |
|---------|--------|
| `path.join('src', 'packages', 'cli')` | CORRECT |
| `'src/cli/commands'` | CORRECT — forward slashes work everywhere |
| `'src\\packages\\cli'` | WRONG — breaks on Linux |
| `'C:\\Users\\...'` | WRONG — hardcoded drive letter |

**Always use `pathToFileURL()` for dynamic imports.** Never construct `file://` URLs by string concatenation.

```typescript
// CORRECT
import { pathToFileURL } from 'url';
const mod = await import(pathToFileURL(absolutePath).href);

// WRONG — breaks on Windows, fragile on Linux
const mod = await import(`file://${absolutePath}`);
```

---

## Line Endings

**All source files, bin scripts, and config files MUST use LF (`\n`) line endings.** CRLF (`\r\n`) in shebang files causes `bad interpreter` errors on Linux.

**When parsing file content, always handle both line endings.** Use `.split(/\r?\n/)` instead of `.split('\n')` when reading files from disk, because files may have been created on Windows.

| Pattern | Status |
|---------|--------|
| `content.split(/\r?\n/)` | CORRECT — handles both |
| `content.split('\n')` | WRONG — leaves `\r` on Windows-created files |
| `content.split('\r\n')` | WRONG — breaks on Linux files |

---

## Home Directory and Environment Variables

**Always use `os.homedir()` for the user's home directory.** Never use raw `process.env.HOME`, `process.env.USERPROFILE`, or `process.env.HOMEDRIVE` alone.

| Pattern | Status |
|---------|--------|
| `os.homedir()` | CORRECT — works everywhere |
| `process.env.HOME \|\| process.env.USERPROFILE` | ACCEPTABLE — only if `os.homedir()` is unavailable |
| `process.env.HOME \|\| '~'` | WRONG — `~` is not resolved by `path.resolve()` |

**Platform-specific environment variables:**

| Variable | Platform | Cross-Platform Alternative |
|----------|----------|---------------------------|
| `HOME` | Linux/macOS | `os.homedir()` |
| `USERPROFILE` | Windows | `os.homedir()` |
| `APPDATA` | Windows | `path.join(os.homedir(), '.config')` on Linux |
| `TEMP` / `TMP` | Windows | `os.tmpdir()` |

---

## Shell Commands and Process Spawning

**Every `child_process.exec/spawn` call MUST handle platform differences.** Use `process.platform === 'win32'` to branch where needed.

| Operation | Linux/macOS | Windows |
|-----------|-------------|---------|
| Find executable | `which` | `where` |
| Null device | `/dev/null` | `NUL` |
| Shell | `/bin/sh` | `cmd.exe` |
| Kill process | `kill <pid>` | `taskkill /PID <pid>` |
| List processes | `ps -eo pid,command` | `tasklist` |

**Shell escape functions MUST match the target shell.** POSIX single-quote escaping (`'arg'`) does not work in `cmd.exe`. If you select `cmd.exe` as the shell on Windows, escape with `"` or `^`.

---

## Shebang Files (bin/ Directory)

**All files in `bin/` MUST have:**
1. A `#!/usr/bin/env node` shebang as the first line
2. LF line endings (enforced via `.gitattributes`)
3. No Windows-specific assumptions in the script body

The `.gitattributes` file MUST include `bin/* eol=lf` to prevent CRLF from being checked out on Windows and breaking Linux installs.

---

## File System Operations

**Case sensitivity:** Linux filesystems are case-sensitive. `Foo.ts` and `foo.ts` are different files. All imports MUST match the exact case of the target filename.

**File permissions:** `fs.chmod()` is a no-op on Windows. Use it for Linux/macOS security (e.g., `0o600` for secrets), but never depend on it for correctness on Windows.

**Temp directories:** Always use `os.tmpdir()` — never hardcode `/tmp/` or `%TEMP%`.

---

## Import and Module Resolution

**`import.meta.url` comparison:** Never compare `import.meta.url` with string-concatenated `file://` paths. Use `pathToFileURL()`.

```typescript
// CORRECT
import { pathToFileURL } from 'url';
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;

// WRONG — fails on Windows
const isMain = import.meta.url === `file://${process.argv[1]}`;
```

**Path checks for absolute paths:** Don't check only for Unix-style absolute paths (`startsWith('/')`). Windows absolute paths start with drive letters (`C:\`). Use `path.isAbsolute()`.

```typescript
// CORRECT
import path from 'path';
if (path.isAbsolute(modulePath)) { ... }

// WRONG — misses Windows paths
if (modulePath.startsWith('/')) { ... }
```

---

## Checklist for Every Code Change

Before submitting any code change, verify:

1. No hardcoded `\` path separators or drive letters
2. No `file://` URLs constructed by string concatenation — use `pathToFileURL()`
3. No `.split('\n')` on file content — use `.split(/\r?\n/)`
4. No raw `process.env.HOME` — use `os.homedir()`
5. No Unix-only commands without Windows fallback (and vice versa)
6. No case-mismatched imports
7. No `startsWith('/')` as the sole absolute-path check — use `path.isAbsolute()`
8. Bin scripts have LF line endings and proper shebangs

---

## See Also

- `CLAUDE.md` — Consumer project checklist, build rules
- `.claude/guidance/shipped/moflo-source-hygiene.md` — Source code hygiene rules
