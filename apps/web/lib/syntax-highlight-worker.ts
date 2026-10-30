import { parentPort } from 'node:worker_threads';
import type { HighlightJob, HighlightJobResult } from './syntax-highlight-common.ts';
import { tokenizeText } from './syntax-highlight-shiki.ts';

// Entry of the highlight worker thread (SPEC-123 FR-123-78). syntax-highlight.ts starts it with
// `new Worker(new URL('./syntax-highlight-worker.ts', import.meta.url))`, which Next.js bundles
// into the server build as a separate entry, and terminates it when a job passes its deadline:
// that is the only way to stop a synchronous RegExp.exec in Shiki's scanner. The relative
// imports name their `.ts` files so the unbuilt entry also runs in Node directly (unit tests).

/** Tokenizes the texts of one job in order; tokenizeText never throws. */
export async function runHighlightJob({
  texts,
  lineTimeLimitMs,
}: HighlightJob): Promise<HighlightJobResult> {
  const results = [];
  for (const { text, language } of texts) {
    results.push(await tokenizeText(text, language, { lineTimeLimitMs }));
  }
  return { results };
}

// Jobs arrive one at a time: the request side sends the next one only after this answer.
const port = parentPort;
if (port) {
  port.on('message', (job: HighlightJob) => {
    void runHighlightJob(job).then((result) => port.postMessage(result));
  });
}
