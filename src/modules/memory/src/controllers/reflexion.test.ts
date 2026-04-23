import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { Database } from 'sql.js';
import { Reflexion } from './reflexion.js';
import { deterministicTestEmbedder } from './_test-embedder.js';

let SQL: any;

beforeAll(async () => {
  SQL = await initSqlJs();
});

describe('Reflexion', () => {
  let db: Database;
  let reflexion: Reflexion;

  beforeEach(() => {
    db = new SQL.Database();
    reflexion = new Reflexion(db as any, { embedder: deterministicTestEmbedder });
  });

  it('rejects null db', () => {
    expect(() => new Reflexion(null as any)).toThrow(/requires a sql\.js/i);
  });

  it('creates schema idempotently', () => {
    const second = new Reflexion(db as any, { embedder: deterministicTestEmbedder });
    expect(second.count()).toBe(0);
  });

  it('adds and counts reflections', async () => {
    await reflexion.addReflection({ action: 'build', outcome: 'fail', reflection: 'need tests' });
    await reflexion.addReflection({ action: 'build', outcome: 'ok', reflection: 'added tests' });
    expect(reflexion.count()).toBe(2);
  });

  it('retrieves reflections ranked by similarity', async () => {
    await reflexion.addReflection({
      action: 'parse JSON config',
      outcome: 'SyntaxError on trailing comma',
      reflection: 'validate before parse',
    });
    await reflexion.addReflection({
      action: 'rename branch',
      outcome: 'git error remote ref',
      reflection: 'push new name first',
    });
    const hits = await reflexion.search('json parse failure', 2);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].action).toBe('parse JSON config');
  });

  it('starts and ends an episode', async () => {
    await reflexion.startEpisode('s-1', { context: 'unit test' });
    expect(reflexion.episodeCount()).toBe(1);
    const before = reflexion.getEpisode('s-1');
    expect(before?.endedAt).toBeNull();

    await reflexion.endEpisode('s-1', {
      summary: 'done',
      tasksCompleted: 2,
      patternsLearned: 1,
    });
    const after = reflexion.getEpisode('s-1');
    expect(after?.endedAt).not.toBeNull();
    expect(after?.summary).toBe('done');
    expect(after?.tasksCompleted).toBe(2);
  });

  it('endEpisode without matching startEpisode still records the row', async () => {
    await reflexion.endEpisode('s-orphan', { summary: 'no start' });
    expect(reflexion.episodeCount()).toBe(1);
    const row = reflexion.getEpisode('s-orphan');
    expect(row?.summary).toBe('no start');
  });

  it('lists episodes newest first', async () => {
    await reflexion.startEpisode('a');
    await new Promise((r) => setTimeout(r, 5));
    await reflexion.startEpisode('b');
    const list = reflexion.listEpisodes();
    expect(list.map((e) => e.sessionId)).toEqual(['b', 'a']);
  });

  it('serializes embedding as BLOB', async () => {
    await reflexion.addReflection({
      action: 'alpha',
      outcome: 'beta',
      reflection: 'gamma',
    });
    const stmt = db.prepare(`SELECT embedding FROM ${Reflexion.REFLEXIONS_TABLE} LIMIT 1`);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    expect(row.embedding).toBeInstanceOf(Uint8Array);
    // 384 dims × 4 bytes
    expect((row.embedding as Uint8Array).byteLength).toBe(384 * 4);
  });

  it('startEpisode is idempotent on the same session id', async () => {
    await reflexion.startEpisode('dup', { context: 'first' });
    await reflexion.startEpisode('dup', { context: 'second' });
    expect(reflexion.episodeCount()).toBe(1);
    expect(reflexion.getEpisode('dup')?.context).toBe('second');
  });
});
