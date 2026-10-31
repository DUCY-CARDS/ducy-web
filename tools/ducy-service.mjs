#!/usr/bin/env node
// A command line for a club service (src/club-services.js): run it on the
// outside server that gives club members chips. Node 20 or later.
//
//   node ducy-service.mjs init [key file]          make the service's key (once)
//   node ducy-service.mjs line [key file]          print its service line again
//   node ducy-service.mjs status  --club CODE
//   node ducy-service.mjs members --club CODE
//   node ducy-service.mjs give <member> <amount> [note] --club CODE [--key K]
//   node ducy-service.mjs take <member> <amount> [note] --club CODE [--key K]
//
// The key file defaults to ./ducy-service-key.json (or DUCY_SERVICE_KEY). It
// holds the private key: only this server should be able to read it, and it
// never needs to go anywhere else. With DUCY_SERVICE_PASSWORD set, init
// locks it with that password and the other commands use it to open it.
// --relay (or DUCY_RELAY) picks another relay; the default is ducy's.
//
// The club's owner adds the service on their club page (Settings, Services)
// by pasting the service line init prints, and checks the ID matches.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { initSync } from '../wasm/ducy_wasm.js';
import { newService, openService, serviceClient, DEFAULT_SERVICE_RELAY } from '../src/service-client.js';
import { serviceLine } from '../src/club-services.js';
import { showId } from '../src/identity.js';

// ducy's engine (the site's wasm build, ../wasm) makes the JSON every
// request is signed over (identity.js, #460).
initSync({module: readFileSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url))});

const argv = process.argv.slice(2);
const flags = {};
const words = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[i + 1], i++;
  else words.push(argv[i]);
}
const [cmd, ...rest] = words;
const password = process.env.DUCY_SERVICE_PASSWORD || '';
const fail = msg => { console.error(msg); process.exit(1); };

async function main() {
  if (cmd === 'init') {
    const file = rest[0] || process.env.DUCY_SERVICE_KEY || 'ducy-service-key.json';
    if (existsSync(file)) fail(`${file} already exists: one key per service. Delete it first to make a new one (the club's owner then adds the new line).`);
    const svc = await newService({password});
    writeFileSync(file, svc.file, {mode: 0o600});
    chmodSync(file, 0o600);
    console.log(`Saved the service's key to ${file}${password ? ', locked with DUCY_SERVICE_PASSWORD' : ''}. Keep it private.`);
    console.log(`Service ID: ${showId(svc.identity.id)}`);
    console.log('Give the club\'s owner this service line (it holds only the public key):');
    console.log(svc.line);
    return;
  }
  const file = flags.keyfile || process.env.DUCY_SERVICE_KEY || 'ducy-service-key.json';
  if (!existsSync(file)) fail(`No key file ${file}: run init first.`);
  const identity = await openService(readFileSync(file, 'utf8'), {password});
  if (cmd === 'line') {
    console.log(`Service ID: ${showId(identity.id)}`);
    console.log(serviceLine(identity));
    return;
  }
  const club = flags.club || process.env.DUCY_CLUB;
  if (!club) fail('Which club? --club CODE (or DUCY_CLUB).');
  const client = serviceClient({identity, relay: flags.relay || process.env.DUCY_RELAY || DEFAULT_SERVICE_RELAY, club});
  let out;
  if (cmd === 'status') out = await client.status();
  else if (cmd === 'members') out = await client.members();
  else if (cmd === 'give' || cmd === 'take') {
    const [member, amount, ...note] = rest;
    if (!member || !amount) fail(`${cmd} <member> <amount> [note]`);
    out = await client[cmd](member, Number(amount), {note: note.join(' '), key: flags.key});
  } else fail('Commands: init, line, status, members, give, take.');
  console.log(JSON.stringify(out, null, 2));
}

main().catch(e => fail(`${e.status ? `${e.status}: ` : ''}${e.message}`));
