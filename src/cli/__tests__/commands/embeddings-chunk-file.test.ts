/**
 * Tests for `flo embeddings chunk --file`.
 *
 * Two defects, one surface: `--text` was `required` at the parser level while
 * `--file` was documented as the alternative ("File to chunk (instead of
 * text)") and carried its own example, `flo embeddings chunk -f doc.txt
 * --strategy paragraph`. That example could not run — the parser rejected it
 * with "Required option missing: --text" — and even when the requirement was
 * satisfied, the action never read `ctx.flags.file`, so it chunked the empty
 * string. A declared, described, exampled option that did nothing.
 *
 * Validates that chunk:
 *  - chunks a file's contents when given --file
 *  - still chunks --text
 *  - errors cleanly on a missing file and when given neither source
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { embeddingsCommand } from '../../commands/embeddings.js';
import type { CommandContext } from '../../types.js';

const chunkCommand = () => embeddingsCommand.subcommands!.find(c => c.name === 'chunk')!;

let tmpDir: string;
let ctx: CommandContext;

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-chunk-')));
  ctx = { args: [], flags: { _: [] }, cwd: tmpDir, interactive: false };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('embeddings chunk', () => {
  it('does not require --text at the parser level', () => {
    const text = chunkCommand().options!.find(o => o.name === 'text')!;

    // The requirement is what made `chunk -f doc.txt` impossible.
    expect(text.required).toBeFalsy();
  });

  it('chunks the contents of --file', async () => {
    const path = join(tmpDir, 'doc.txt');
    writeFileSync(path, 'Alpha sentence here. Beta sentence here. Gamma sentence here.');

    const result = await chunkCommand().action!({ ...ctx, flags: { file: path, _: [] } });

    expect(result.success).toBe(true);
  });

  it('still chunks --text', async () => {
    const result = await chunkCommand().action!({
      ...ctx,
      flags: { text: 'One sentence. Two sentence.', _: [] },
    });

    expect(result.success).toBe(true);
  });

  // Rule #1: a document must chunk identically regardless of the platform it
  // was authored on. `chunking.ts` splits paragraphs on /\n\n+/, which a
  // CRLF file's \r\n\r\n does not match — so without normalization the same
  // file chunks differently on Windows than on POSIX.
  it('chunks a CRLF file identically to its LF twin', async () => {
    const paragraphs = [
      'First paragraph here with some content.',
      'Second paragraph here with some content.',
      'Third paragraph here with some content.',
    ];
    const lfPath = join(tmpDir, 'lf.txt');
    const crlfPath = join(tmpDir, 'crlf.txt');
    writeFileSync(lfPath, paragraphs.join('\n\n'));
    writeFileSync(crlfPath, paragraphs.join('\r\n\r\n'));

    const run = async (path: string) =>
      chunkCommand().action!({ ...ctx, flags: { file: path, strategy: 'paragraph', _: [] } });

    const lf = await run(lfPath);
    const crlf = await run(crlfPath);

    expect(lf.success).toBe(true);
    expect(crlf.success).toBe(true);
    expect(crlf.data).toEqual(lf.data);
  });

  it('errors when the file does not exist', async () => {
    const result = await chunkCommand().action!({
      ...ctx,
      flags: { file: join(tmpDir, 'nope.txt'), _: [] },
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('errors when given neither --text nor --file', async () => {
    const result = await chunkCommand().action!({ ...ctx, flags: { _: [] } });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});
