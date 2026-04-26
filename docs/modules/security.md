# security (deleted)

> **Deleted as dead code by [#594](https://github.com/eric-cielo/moflo/issues/594)** (epic [#586](https://github.com/eric-cielo/moflo/issues/586) / [ADR-0001](../adr/0001-collapse-moflo-workspace-packages.md)). The `@moflo/security` workspace package no longer exists and is not relocated anywhere. Fifth removal in the workspace-collapse sequence after `aidefence` #590 (inlined), `claims` #591 (deleted), `embeddings` #592 (inlined), `plugins` #593 (deleted).

## Why deleted, not inlined

A symbol-by-symbol usage scan returned **zero production callers** for `PathValidator`, `SafeExecutor`, `CredentialGenerator`, `TokenGenerator`, `InputValidator`, `createSecurityModule`, `auditSecurityConfig`, or any of the validation schemas. The "inbound from cli/hooks" edges in `docs/adr/collapse-deps.md` were entirely string-literal mentions in metadata: plugin-store demo data, the update-checker priority list, the peer-dep `COMPATIBILITY_MATRIX`, the DDD-pattern scanner's module list, and CLI plugins help text. Nothing called the code.

The only re-export was `src/index.ts` (an unshipped library entry — `dist/index.js` is `package.json#main` but is not in `package.json#files`). The CLI ships through `bin/cli.js`, which never traverses `src/index.ts`.

Inlining dead code into `cli/src/security/` would just relocate noise. Per claims (#591) and plugins (#593) precedent, the right call was deletion.

## What this module did (for git-history readers)

CVE remediation primitives + a Valibot-schema input validator + secure token / credential generation, originating in the Ruvnet/ruflo fork's audit response:

- `PathValidator` — prefix allowlist, symlink resolution, null-byte rejection (HIGH-2).
- `SafeExecutor` — allowlisted-binary command execution with argument sanitization (HIGH-1).
- `CredentialGenerator` — cryptographically secure password / API-key generation (CVE-3).
- `TokenGenerator` — HMAC-signed tokens, expirations, timing-safe comparison.
- `InputValidator` + Valibot schemas (`SafeStringSchema`, `EmailSchema`, etc.).
- DDD wrappers (`SecurityContext`, `SecurityDomainService`, `SecurityApplicationService`).

## Where the live security primitives are

If you need any of these capabilities in production code, use the live alternatives:

- **Path / command validation, ID generation, sanitization** → [`src/modules/shared/src/security/`](../../src/modules/shared/src/security/) exports `validateInput`, `validatePath`, `validateCommand`, `sanitizeString`, `escapeForSql`, `generateSecureId`, `generateUUID`, `generateSecureToken`, `secureRandomInt`, etc.
- **AI manipulation defense / prompt injection / jailbreak detection** → [`src/cli/aidefence/`](../../src/cli/aidefence/) (used by `flo security` CLI and the `aidefence_*` MCP tools).
- **CLI security commands** → `src/cli/commands/security.ts` (the `flo security` command tree).
- **MCP security tools** → `src/cli/mcp-tools/security-tools.ts` (registers `aidefence_*` tools).

If a future feature genuinely needs HMAC-signed tokens or a prefix-allowlist `PathValidator`, write a focused implementation when needed — don't resurrect shelfware.
