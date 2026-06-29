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

**Never *live-share* the entire `moflo.db` between two running daemons.** node:sqlite + WAL stops concurrent writers from losing rows, but each daemon builds its own in-memory HNSW index — a write in install A never updates install B's index, so search silently returns stale results, and structural namespaces churn across branches. For ongoing sync, share ONLY the durable slice.

> **Not the same thing:** restoring a one-time whole-DB *snapshot* to seed a fresh/empty workspace is safe and fast — each workspace then owns its own copy (no second concurrent daemon, so no index divergence), and the incremental reindex reconciles branch drift. That avoids the cold-start full parse + re-embed and is the right tool when speed-to-ready matters. Use `flo memory backup`/`restore` for it — see "Hydrate a Fresh Workspace from a Snapshot" below. The rule above is specifically about *live concurrent* sharing.

---

## Pick the Mechanism by Topology

Choose by who needs the learnings, not by what is easiest to wire.

| Topology | Mechanism | How |
|----------|-----------|-----|
| Same machine, many worktrees / Conductor workspaces | `memory.durable_path` | Point every checkout at one durable-only store; session-start seeds + writes through automatically |
| One person, many machines | `flo memory sync` | `--to <file>` then `--from <file>` via a synced folder (Dropbox/iCloud) or a hand-copied file |
| A team sharing one repo | Git-tracked team artifact | `flo memory team-export` writes `.moflo/shared/learnings.jsonl`; teammates' session-start import-merges it after `git pull` |
| A fresh/empty workspace that must be ready FAST | Whole-DB snapshot (`memory.hydrate_from`) | `flo memory backup --to <snap>` once; a new workspace restores the entire DB so search works on session one — no cold reindex |

The first three move the SAME durable slice and dedupe on `UNIQUE(namespace, key)`, so combining them is conflict-free. The snapshot is a different tool — a one-time whole-DB seed that composes with the durable-slice modes (see the next section but one).

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

## Hydrate a Fresh Workspace from a Snapshot

Use a whole-DB snapshot when a new workspace must be searchable on its FIRST session. An empty `.moflo/moflo.db` forces a full cold reindex — parse every file for `code-map`/`patterns`/`tests`, chunk all `guidance`, AND run ONNX embedding generation over all of it (minutes on a large repo). A snapshot restore skips both the parse and the embed.

```bash
flo memory backup  --to   ~/moflo-snapshots/myproject.db   # snapshot a warm workspace (VACUUM INTO — consistent even under an active WAL)
flo memory restore --from ~/moflo-snapshots/myproject.db   # seed a fresh workspace (no-op if the local DB already has content; --force to override)
```

Auto-hydrate on session-start by setting `memory.hydrate_from` (env `MOFLO_HYDRATE_FROM` overrides):

```yaml
memory:
  hydrate_from: /abs/path/to/moflo-snapshot.db   # restored only when the local DB is empty, before the daemon starts
```

| Behavior | Rule |
|----------|------|
| When it restores | Only when the local DB is absent/empty (never clobbers an active workspace unless `--force`) |
| Ephemeral leak | Source `tasklist`/`hive-mind`/epic-state are purged from the restored copy |
| Branch drift | Self-heals on the next incremental reindex |
| Order vs. durable-slice | Hydrate runs BEFORE the durable-slice sync at session-start — snapshot is the fast one-time seed, durable-slice keeps `learnings` converged afterward |

This is NOT whole-DB *live* sharing: each restored workspace owns its own copy, so there is no second concurrent daemon and no HNSW index divergence.

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
