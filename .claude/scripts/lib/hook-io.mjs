/**
 * Shared hook I/O primitives for moflo's bin/*.mjs hook handlers.
 *
 * Extracted (#1198) so the UserPromptSubmit/Stop capture hook
 * (meditate-capture.mjs) and the passive session-continuity Stop hook
 * (session-continuity.mjs) share ONE implementation of "read the hook's JSON
 * stdin" — a bug in the bounded-read logic gets fixed once, not per copy.
 *
 * Cross-platform (Rule #1): Node fs primitives only; no shell.
 */

import { existsSync, openSync, readSync, closeSync, statSync, readFileSync } from 'fs';

/**
 * Read a hook's JSON stdin (session_id, transcript_path, prompt, …). Bounded by
 * a 500ms cap so a missing/withheld stdin can never hang the hook; the timer is
 * cleared on a normal end so the process exits immediately instead of lingering
 * up to 500ms. Never throws — returns {} on any parse/IO error.
 *
 * @returns {Promise<Record<string, any>>}
 */
export async function readHookStdin() {
  if (process.stdin.isTTY) return {};
  return new Promise((res) => {
    let data = '';
    let done = false;
    let timer = null;
    const parse = (s) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
    const finish = () => { if (done) return; done = true; if (timer) clearTimeout(timer); res(parse(data)); };
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (c) => { if (!done) data += c; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    timer = setTimeout(finish, 500);
  });
}

/**
 * Read the last `bytes` of a file as UTF-8. Returns '' on any error. The first
 * (likely partial) line is the caller's concern — JSONL/transcript parsers
 * tolerate a truncated leading line.
 *
 * @param {string} path
 * @param {number} bytes
 * @returns {string}
 */
export function readFileTail(path, bytes) {
  try {
    if (!path || !existsSync(path)) return '';
    const size = statSync(path).size;
    if (size <= bytes) return readFileSync(path, 'utf-8');
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      readSync(fd, buf, 0, bytes, size - bytes);
      return buf.toString('utf-8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}
