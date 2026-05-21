# Contributing to MoFlo

Thanks for your interest in improving MoFlo! This project is free and open source
(MIT), and contributions of all kinds are welcome — bug reports, documentation,
tests, and code.

This document covers how to get set up, the conventions we follow, and what we
look for in a pull request. By participating, you agree to abide by our
[Code of Conduct](./CODE_OF_CONDUCT.md).

## What MoFlo is (read this first)

MoFlo is a **library shipped to other projects**. Consumers install it as a
`devDependency` (`npm install --save-dev moflo`) and it runs from their
`node_modules/moflo/...` on their machines. It is **not** a standalone app.

Two consequences shape almost every contribution:

1. **Cross-platform is mandatory.** All shipped code must work identically on
   Linux, macOS, and Windows. See [Cross-platform requirements](#cross-platform-requirements).
2. **Changes ship to real consumers.** Before a non-trivial change, think about
   what breaks for someone who upgrades to your version via `npm install`.

## Getting started

### Prerequisites

- **Node.js >= 22** (MoFlo uses Node's built-in `node:sqlite`, so an older
  Node will not work).
- **npm** (ships with Node).
- **git**.

### Setup

```bash
git clone https://github.com/eric-cielo/moflo.git
cd moflo
npm install
npm run build
```

### Common commands

| Command | What it does |
| --- | --- |
| `npm run build` | Compile TypeScript (`tsc`) to `dist/`. |
| `npm test` | Run the test suite. |
| `npm run lint` | Lint with ESLint (zero warnings allowed). |
| `npm run test:smoke` | Run the consumer smoke harness (simulates a real install). |
| `npm run dev` | Run the CLI from source in watch mode. |

Run `npm run build`, `npm test`, and `npm run lint` before opening a PR — CI runs
all three across Linux, macOS, and Windows.

## Reporting bugs and requesting features

Open an issue at <https://github.com/eric-cielo/moflo/issues>. A good bug report
includes:

- Your OS and Node version.
- The MoFlo version (`flo --version` or your `package.json`).
- Steps to reproduce, what you expected, and what actually happened.
- Relevant output or logs (redact anything sensitive).

For security issues, **do not** open a public issue — see
[Reporting security issues](#reporting-security-issues).

## Making changes

### Branching

Create a feature branch off `main`:

```bash
git checkout -b fix/short-description
```

### Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/). Prefix each
commit with its type:

- `feat:` — a new feature
- `fix:` — a bug fix
- `docs:` — documentation only
- `chore:` — tooling, deps, or housekeeping
- `ci:` — CI/build pipeline changes
- `refactor:` — code change that neither fixes a bug nor adds a feature
- `test:` — adding or fixing tests

Example: `fix: resolve project root via realpath on macOS`

### Pull requests

1. Keep PRs focused — one logical change per PR.
2. Make sure `npm run build`, `npm test`, and `npm run lint` all pass locally.
3. Add or update tests for any behavior change.
4. Update documentation (README, guidance docs) in the **same PR** as the code —
   don't leave stale docs for a follow-up.
5. Describe the change clearly: what it does, why, and how you verified it.

A maintainer will review your PR. CI must be green on all platforms before merge.

## Cross-platform requirements

This is the single most important rule for shipped code. Audit every change
against this checklist:

- **Paths** — use `path.join` / `path.sep` / `path.resolve`. Never hardcode `/`,
  `\`, `/tmp`, `C:\…`, etc.
- **Shell commands** — `bash`, `grep`, `sed`, `cat`, `find` don't exist on a
  default Windows box. Use Node primitives (`fs`, `child_process` with `spawn`,
  not a shell) instead of shelling out.
- **Symlinks & case sensitivity** — POSIX has symlinks and is case-sensitive;
  Windows/macOS mostly aren't. `fs.realpathSync` both sides before comparing
  paths for identity.
- **Line endings** — normalize EOL or use `.gitattributes`; don't hash raw file
  contents in tests without normalizing.
- **Temp dirs & ports** — use `os.tmpdir()`; in tests use ports 40000–44999
  (Windows reserves 49152–65535).

Don't trust your local OS. CI runs the smoke harness on all three platforms — if
you're on Windows, mentally simulate the POSIX path, and vice versa.

## Code quality

- **No broken windows.** Fix every failing test and warning before moving on. A
  red signal is never acceptable as background noise. If a test is flaky, fix the
  flakiness at its source rather than retrying.
- **Keep modules focused.** Prefer small, single-purpose files; large files
  should be decomposed.
- **Don't duplicate logic.** Share code between call sites (DRY).
- **Match the surrounding style.** New code should read like the code around it.

## Reporting security issues

Please report security vulnerabilities privately to **eric@cielolimitada.com**
rather than opening a public issue. Include a description, reproduction steps,
and the affected version. We'll acknowledge your report and work with you on a
fix and disclosure timeline.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](./LICENSE) that covers this project.
