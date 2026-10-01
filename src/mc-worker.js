// Runs Monte Carlo jobs off the main thread. Protocol:
//   in:  {type: 'run', id, job, budgetMs, maxSamples}   {type: 'stop', id}
//   out: {type: 'ready'}   {type: 'done', id, state}   {type: 'error', id, message}
import init from '../wasm/ducy_wasm.js';
import { newState, runChunk } from './mc.js';

const CHUNK_MS = 50;
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
  const state = newState(msg.job);
  try {
    while (!run.stopped && performance.now() < deadline && state.done < msg.maxSamples) {
      runChunk(msg.job, state, Math.min(deadline, performance.now() + CHUNK_MS), msg.maxSamples);
      // Yield so a 'stop' (or a newer 'run') can be received between chunks.
      await new Promise(r => setTimeout(r, 0));
      if (current !== run) return;
    }
    if (!run.stopped) postMessage({type: 'done', id: run.id, state});
  } catch (err) {
    postMessage({type: 'error', id: run.id, message: String(err && err.message || err)});
  }
};
