/**
 * Populated-consumer check for #1506: the one-file-per-entry team artifact,
 * driven through the INSTALLED `flo` on all three CI platforms.
 *
 * The unit tests prove the layout against the source tree on Linux only; the
 * layout is mostly path handling (hashed file names, a namespace subdirectory,
 * a `.gitattributes` glob), which is exactly what diverges on Windows and
 * macOS. Runs after the durable-heal check, whose `team-export` meets the
 * seeded single-file `learnings.jsonl` and must have migrated it.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { flo } from './proc.mjs';
import { section, record, recordExit } from './report.mjs';
import { MOFLO_DIR } from '../../../bin/lib/moflo-paths.mjs';

const ENTRY_FILE = /^[0-9a-f]{64}\.json$/;

/** Entry files under the artifact directory, as `<namespace-dir>/<file>`. */
function entryFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((ns) => readdirSync(join(dir, ns)).map((f) => `${ns}/${f}`));
}

const readAll = (dir) => entryFiles(dir).map((f) => readFileSync(join(dir, ...f.split('/')), 'utf-8'));

/** @param {string} consumerDir */
export function runTeamDirCheck(consumerDir) {
  section('Populated: one-file-per-entry team artifact (#1506)');

  const shared = join(consumerDir, MOFLO_DIR, 'shared');
  const dir = join(shared, 'learnings');

  const legacyGone = !existsSync(join(shared, 'learnings.jsonl'));
  record('populated:team-dir-migrated', legacyGone ? 'pass' : 'fail', legacyGone ? undefined : 'team-export left learnings.jsonl in place');

  const files = entryFiles(dir);
  const badNames = files.filter((f) => !ENTRY_FILE.test(f.split('/')[1]));
  const filesOk = files.length > 0 && badNames.length === 0;
  record(
    'populated:team-dir-files',
    filesOk ? 'pass' : 'fail',
    files.length === 0 ? 'no entry files written' : badNames.length ? `unexpected names: ${badNames.join(', ')}` : `${files.length} entry file(s)`,
  );

  const attributes = join(consumerDir, '.gitattributes');
  const pinned = existsSync(attributes) && readFileSync(attributes, 'utf-8').includes('/.moflo/shared/learnings/** text eol=lf');
  record('populated:team-dir-gitattributes', pinned ? 'pass' : 'fail', pinned ? undefined : 'directory LF pin missing from .gitattributes');

  // A no-op export must leave every entry file byte-identical — on Windows a
  // CRLF or path-separator slip shows up here as a full rewrite.
  const before = readAll(dir);
  if (!recordExit('populated:team-dir-export', flo(consumerDir, ['memory', 'team-export'], { timeout: 60_000 }))) return;
  const stable = JSON.stringify(readAll(dir)) === JSON.stringify(before);
  record('populated:team-dir-export-stable', stable ? 'pass' : 'fail', stable ? undefined : 'a no-op export rewrote entry files');

  recordExit('populated:team-dir-import', flo(consumerDir, ['memory', 'team-import'], { timeout: 60_000 }));
}
