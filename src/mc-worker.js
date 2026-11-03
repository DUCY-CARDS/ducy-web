// Runs Monte Carlo jobs off the main thread: ducy-wasm's EquityJob
// (equity_job.rs) samples; this keeps the clock. Protocol:
//   in:  {type: 'run', id, job, budgetMs, maxSamples}   {type: 'stop', id}
//   out: {type: 'ready'}   {type: 'done', id, state}   {type: 'error', id, message}
import init, { EquityJob } from '../wasm/ducy_wasm.js';

const CHUNK_MS = 50;
// Samples per EquityJob.run call.
const PER_RUN = 1000;
let current = null;

const ready = init({module_or_path: new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url)})
  .then(() => postMessage({type: 'ready'}));

self.onmessage = async e => {
  const msg = e.data;
  if (msg.type === 'stop') {
    if (current && current.id === msg.id) current.stopped = true;
    return;
  }
  if (msg.type !== 'run') return;

  await ready;
  const run = {id: msg.id, stopped: false};
  current = run;
  const deadline = performance.now() + msg.budgetMs;
  let job = null;
  try {
    job = new EquityJob(msg.job);
    while (!run.stopped && performance.now() < deadline && job.done() < msg.maxSamples) {
      const until = Math.min(deadline, performance.now() + CHUNK_MS);
      while (performance.now() < until && job.done() < msg.maxSamples) job.run(PER_RUN);
      // Yield so a 'stop' (or a newer 'run') can be received between chunks.
      await new Promise(r => setTimeout(r, 0));
      if (current !== run) return;
    }
    if (!run.stopped) postMessage({type: 'done', id: run.id, state: job.totals()});
  } catch (err) {
    postMessage({type: 'error', id: run.id, message: String(err && err.message || err)});
  } finally {
    job?.free();
  }
};
