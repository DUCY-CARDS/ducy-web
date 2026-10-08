// Loads ducy's wasm build (wasm/, built from ducy master as CI and deploy do)
// for tests of modules that call its bindings. Import it before them.
import { readFileSync } from 'node:fs';
import { initSync } from '../wasm/ducy_wasm.js';

initSync({module: readFileSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url))});
