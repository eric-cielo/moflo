import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { Database } from 'sql.js';
import { Skills } from './skills.js';
import { deterministicTestEmbedder } from './_test-embedder.js';

let SQL: any;

beforeAll(async () => {
  SQL = await initSqlJs();
});

describe('Skills', () => {
  let db: Database;
  let skills: Skills;

  beforeEach(() => {
    db = new SQL.Database();
    skills = new Skills(db as any, { embedder: deterministicTestEmbedder });
  });

  it('rejects null db', () => {
    expect(() => new Skills(null as any)).toThrow(/requires a sql\.js/i);
  });

  it('adds and counts skills', async () => {
    await skills.addSkill({ name: 'bisect-git', description: 'binary search commits' });
    await skills.addSkill({ name: 'parse-json', description: 'safely parse JSON' });
    expect(skills.count()).toBe(2);
  });

  it('addSkill requires a name', async () => {
    await expect(skills.addSkill({ name: '', description: 'x' } as any)).rejects.toThrow(/non-empty/i);
  });

  it('promote skips below threshold', async () => {
    const r = await skills.promote(
      { name: 'weak', description: 'marginal pattern' },
      0.5,
    );
    expect(r.promoted).toBe(false);
    expect(r.reason).toBe('below_threshold');
    expect(skills.count()).toBe(0);
  });

  it('promote accepts objects with name/description/code', async () => {
    const r = await skills.promote(
      { name: 'retry-api', description: 'retry with backoff', code: 'await retry(fn)' },
      0.95,
    );
    expect(r.promoted).toBe(true);
    expect(r.skillId).toMatch(/^skill-/);
    expect(skills.count()).toBe(1);
  });

  it('promote accepts bare strings', async () => {
    const r = await skills.promote('debounce', 0.9);
    expect(r.promoted).toBe(true);
    expect(skills.count()).toBe(1);
  });

  it('promote is idempotent on same name — updates existing', async () => {
    const first = await skills.promote({ name: 'dedupe', description: 'first' }, 0.9);
    const second = await skills.promote({ name: 'dedupe', description: 'second' }, 0.95);
    expect(skills.count()).toBe(1);
    expect(second.skillId).toBe(first.skillId);
    expect(second.reason).toBe('updated_existing');
  });

  it('promote rejects unparseable input', async () => {
    const r = await skills.promote(42, 0.95);
    expect(r.promoted).toBe(false);
    expect(r.reason).toBe('unparseable_pattern');
  });

  it('search returns results ranked by similarity', async () => {
    await skills.addSkill({ name: 'retry-http', description: 'exponential backoff for HTTP' });
    await skills.addSkill({ name: 'parse-date', description: 'ISO 8601 date parsing' });
    const hits = await skills.search('retry request', 2);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].name).toBe('retry-http');
  });

  it('getSkill / deleteSkill round-trip', async () => {
    const id = await skills.addSkill({ name: 'temp', description: 'temp' });
    expect(skills.getSkill(id)?.name).toBe('temp');
    expect(skills.deleteSkill(id)).toBe(true);
    expect(skills.getSkill(id)).toBeNull();
    expect(skills.deleteSkill('missing')).toBe(false);
  });

  it('list returns newest first', async () => {
    await skills.addSkill({ name: 'a', description: '' });
    await new Promise((r) => setTimeout(r, 2));
    await skills.addSkill({ name: 'b', description: '' });
    const list = skills.list();
    expect(list[0].name).toBe('b');
  });
});
