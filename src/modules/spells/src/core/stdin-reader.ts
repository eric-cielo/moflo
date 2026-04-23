/**
 * Stdin reader — shared interactive-line-of-input helper.
 *
 * Used by both the `prompt` step command and the issue-#460 prerequisite
 * preflight walker; keeps the abort-signal + trimming semantics in one place.
 */
import * as readline from 'node:readline';

/**
 * Read one line from stdin, emitting `promptText` first. Resolves with the
 * user's trimmed answer (empty string if they just hit enter). Honors an
 * optional abort signal — rejects with `Error('Prompt aborted')` if fired.
 */
export async function readLineFromStdin(
  promptText: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onAbort = () => { rl.close(); reject(new Error('Prompt aborted')); };
    if (abortSignal) {
      if (abortSignal.aborted) { rl.close(); reject(new Error('Prompt aborted')); return; }
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    rl.question(promptText, (answer) => {
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      rl.close();
      resolve(answer.trim());
    });
  });
}
