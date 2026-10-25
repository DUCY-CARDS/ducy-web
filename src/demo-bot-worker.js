// The demo clubs' bots decide here, off the page's thread (#415): ducy's
// SeatBot for each bot (demo-bots.js), as play-worker.js runs Quest's tables.
// Request {id, key, bot, seed, view} → {id, result} or {id, error}.
import init, * as wasm from '../wasm/ducy_wasm.js';
import { seatBotAct } from './demo-bots.js';

const ready = init({module_or_path: new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url)});
const bots = new Map();

self.onmessage = async e => {
  const {id, key, bot, seed, view} = e.data;
  try {
    await ready;
    postMessage({id, result: seatBotAct(wasm, bots, key, bot, seed, view)});
  } catch (err) {
    postMessage({id, error: String(err?.message || err)});
  }
};
