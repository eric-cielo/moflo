# Cross-Installation Memory Sharing

**Purpose:** Decide how to share moflo's durable learnings across git worktrees, machines, or a team — and how to do it WITHOUT corrupting search. Read this before configuring `memory.durable_path`, running `flo memory sync`, or pointing two checkouts at one database.

---

## Share the Durable Slice, Never the Whole DB

moflo's `.moflo/moflo.db` holds three classes of data. Only one is worth sharing.

| Class | Namespaces | Shareable? | Why |
|-------|-----------|------------|-----|
| **Durable** | `learnings`, `knowledge` | **Yes** | User-authored, slow to recreate, identical across checkouts |
| **Structural** | `code-map`, guidance chunks | No | Branch-specific; rebuilds cheaply from the indexers |
| **Ephemeral** | `tasklist`, `hive-mind`, epic state | No | Per-run scratch; meaningless in another install |

**Never share the entire `moflo.db` between two installs.** node:sqlite + WAL stops concurrent writers from losing rows, but each daemon builds its own in-memory HNSW index — a write in install A never updates install B's index, so search silently returns stale results, and structural namespaces churn across branches. Share ONLY the durable slice.

---

## Pick the Mechanism by Topology

Choose by who needs the learnings, not by what is easiest to wire.

| Topology | Mechanism | How |
|----------|-----------|-----|
| Same machine, many worktrees / Conductor workspaces | `memory.durable_path` | Point every checkout at one durable-only store; session-start seeds + writes through automatically |
| One person, many machines | `flo memory sync` | `--to <file>` then `--from <file>` via a synced folder (Dropbox/iCloud) or a hand-copied file |
| A team sharing one repo | Git-tracked team artifact | `flo memory team-export` writes `.moflo/shared/learnings.jsonl`; teammates' session-start import-merges it after `git pull` |

All three move the SAME durable slice and dedupe on `UNIQUE(namespace, key)`, so combining them is conflict-free.

---

## Configure a Same-Machine Shared Store

Set `memory.durable_path` in `moflo.yaml` to a dedicated file — NOT a full `moflo.db`.

```yaml
memory:
  durable_path: ~/.moflo-shared/team-learnings.db   # a durable-only store, created on first flush
```

The path must resolve to a file that is NOT any project's `.moflo/moflo.db`. Pointing it at a real `moflo.db` re-introduces the whole-DB-sharing hazard. `MOFLO_DURABLE_PATH` overrides the config per process; relative paths resolve against the project root.

---

## Carry Learnings Between Your Own Machines

Use `flo memory sync` with a portable artifact you keep in a synced folder.

```bash
flo memory sync --to   ~/Dropbox/moflo/durable.db   # on machine A
flo memory sync --from ~/Dropbox/moflo/durable.db   # on machine B
```

`--from` is idempotent (re-running copies nothing new). After an import, restart the Claude Code session (or run `flo memory rebuild-index`) so the merged rows are embedded and searchable.

---

## Share Learnings Across a Team

Commit a git-tracked JSONL artifact so the whole team accumulates each other's learnings about the repo.

```bash
flo memory team-export                       # writes .moflo/shared/learnings.jsonl + makes it git-trackable
git add .moflo/shared/learnings.jsonl && git commit -m "share learnings"
```

Teammates' session-start import-merges the file after `git pull` (first-write-wins on conflicts; author/host provenance is retained). JSONL keeps git diffs reviewable; embeddings are regenerated on import. Enable it with `memory.team_artifact: .moflo/shared/learnings.jsonl`.

---

## Verify the Setup with `flo doctor`

Run the shared-DB check to confirm you are sharing safely.

```bash
flo doctor -c shared-db
```

| Result | Meaning |
|--------|---------|
| **pass** — "durable-only shared store configured" | `durable_path` points at a dedicated file — safe |
| **warn** — "points at a full moflo.db" | `durable_path` aliases or is named like a full DB — repoint it at a dedicated store |
| **warn** — "is a symlink" | The local `moflo.db` is symlinked into a shared location — replace it with a local DB and use `durable_path` |

A foreign-writer warning from the Writers Audit check (`flo doctor -c writers`) means another process is writing the DB outside the daemon's single-writer routing; under node:sqlite + WAL it won't lose rows, but it leaves the daemon's HNSW index stale until it reindexes.

---

## See Also

- `.claude/guidance/moflo-memory-strategy.md` — Namespaces, RAG indexing, and the durable-vs-derived split this doc builds on
- `.claude/guidance/moflo-memory-protocol.md` — Search-and-traverse protocol for the shared `learnings` once it is populated
- `.claude/guidance/moflo-core-guidance.md` — CLI, daemon, and `moflo.yaml` reference (the `memory` config block)
