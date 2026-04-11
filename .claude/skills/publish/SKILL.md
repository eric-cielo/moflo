---
name: publish
description: Bump version, build, test, publish to npm, and install locally
arguments: "[patch|minor|major] [-rc]"
---

# /publish - Version Bump, Build, Test & Publish

Automated release pipeline for moflo. Bumps version, commits, builds, tests, runs doctor, publishes to npm, and installs the new version locally.

**Arguments:** $ARGUMENTS

## Usage

```
/publish              # patch bump (4.8.56 → 4.8.57)
/publish minor        # minor bump (4.8.56 → 4.9.0)
/publish major        # major bump (4.8.56 → 5.0.0)
/publish -rc          # patch RC bump (4.8.56 → 4.8.57-rc.1, or 4.8.57-rc.1 → 4.8.57-rc.2)
/publish minor -rc    # minor RC bump (4.8.56 → 4.9.0-rc.1)
/publish patch        # explicit patch bump
```

## Step-by-Step Procedure

Follow docs/BUILD.md exactly. Every step must succeed before proceeding to the next.

### Step 1: Parse Arguments

- Default bump type is `patch` if not specified
- If `-rc` flag is present, produce a release candidate version
- Determine the new version string:
  - **Without `-rc`:** Use `npm version <patch|minor|major> --no-git-tag-version`
  - **With `-rc`:** Calculate manually:
    - If current version is already an RC of the same bump level (e.g., `4.8.57-rc.3`), increment the RC number (→ `4.8.57-rc.4`)
    - Otherwise, bump the base version and append `-rc.1` (e.g., `4.8.56` → `4.8.57-rc.1`)
    - Write with: `npm version <new-version> --no-git-tag-version`

### Step 2: Rebuild After Version Bump

```bash
npm run build
```

This syncs the version to `src/modules/cli/src/version.ts` and `src/modules/cli/package.json` via the `version` lifecycle script, then compiles all TypeScript.

**Must exit 0.** If it fails, stop and fix the build error.

### Step 3: Run Tests

```bash
npm test
```

**Must have 0 test file failures.** If any test files fail, retest them individually to distinguish real failures from flaky ones (per broken window theory). Fix all real failures before proceeding.

### Step 4: Run Doctor

```bash
npx moflo doctor --fix
```

All checks must pass (warnings are acceptable on Windows for sandbox tier). If doctor finds fixable issues, it will auto-fix them. If manual fixes are needed, stop and address them.

### Step 5: Commit & Push

Commit the version bump files:

```bash
git add package.json package-lock.json src/modules/cli/package.json src/modules/cli/src/version.ts
git commit -m "chore: bump version to <new-version>"
git push origin main
```

Only commit version-related files. Do not stage unrelated changes.

### Step 6: Publish to npm

```bash
npm publish --tag <tag>
```

- For stable releases: `npm publish` (publishes to `latest` tag by default)
- For RC releases: `npm publish --tag rc` (publishes to `rc` tag so it doesn't become `latest`)

**OTP handling:**
- First attempt: run `npm publish` without `--otp`
- If npm prompts for a one-time password or returns an OTP error, ask the user for their authenticator code
- Then retry with: `npm publish --otp=<code> --tag <tag>`

**Login handling:**
- If npm returns a 401/403 or "not logged in" error, tell the user to run `! npm login` (interactive login in their terminal)
- After they confirm login, retry the publish

### Step 7: Verify Publication

```bash
npm view moflo version
npm view moflo dist-tags
```

Confirm the published version matches what we just built.

### Step 8: Install Locally

```bash
npm install moflo@<new-version> --save-dev
```

This updates `package.json` and `package-lock.json` to use the newly published version as a devDependency.

### Step 9: Final Commit

If `package.json` or `package-lock.json` changed from the install:

```bash
git add package.json package-lock.json
git commit -m "chore: install moflo@<new-version>"
git push origin main
```

## Output

Print a summary at the end:

```
Publish Summary
───────────────
Version:    <old> → <new>
Tag:        latest | rc
Build:      passed
Tests:      <N> files passed, <N> tests passed
Doctor:     <N> passed, <N> warnings
Published:  moflo@<new-version>
Installed:  moflo@<new-version> (devDependency)
```

## Important

- All commands run from the project root — never cd into subdirectories
- Never use `--force` on npm publish
- Never install moflo globally — it is always a local devDependency
- If any step fails, stop and fix the issue before proceeding — do not skip steps
- The `prepublishOnly` script in package.json runs `check-version-sync.mjs && npm run build` automatically, so npm publish will fail-fast if versions are out of sync
