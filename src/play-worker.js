// Runs the bot table (ducy-wasm's BotTable) off the main thread, so the page
// stays responsive while a bot thinks; Omaha decisions can take a second or
// two. Protocol: each request {id, op, args} gets {id, result} or {id, error}.
//   ops: personalities | create(bots, buyIn, sb, bb, seed, game) | newHand |
//        advance | act(kind, amount)
// Every table op returns {state, botToAct}.
// Hosting a table for friends uses MultiTable (ops starting with "host"):
//   hostCreate(bots, open, name, buyIn, sb, bb, seed, game, turnMs) |
//   hostNewHand | hostAdvance | hostAct(kind, amount) | hostHandle(client, msg) |
//   hostDisconnected(client) | hostTick
// Those return {seq, state, botToAct, turnMsLeft, openSeats, out}, where out
// lists {to, data} messages for the page to relay to each player.
import init, { BotTable, MultiTable, botPersonalities } from '../wasm/ducy_wasm.js';

const ready = init({module_or_path: new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url)});
let table = null;
let host = null;

const snapshot = state => ({state, botToAct: table.botToAct()});

const ops = {
  personalities: () => botPersonalities(),
  create: (bots, buyIn, sb, bb, seed, game) => {
    table = new BotTable(bots, BigInt(buyIn), BigInt(sb), BigInt(bb), BigInt(seed), game);
    return snapshot(table.newHand());
  },
  newHand: () => snapshot(table.newHand()),
  advance: () => snapshot(table.advance()),
  act: (kind, amount) => snapshot(table.act(kind, BigInt(amount))),
  hostCreate: (bots, open, name, buyIn, sb, bb, seed, game, turnMs) => {
    host = new MultiTable(bots, Uint8Array.from(open, o => (o ? 1 : 0)), name, BigInt(buyIn), BigInt(sb), BigInt(bb), BigInt(seed), game, BigInt(turnMs));
    return host.state(Date.now()); // deal once the players are in
  },
  hostNewHand: () => host.newHand(Date.now()),
  hostAdvance: () => host.advance(Date.now()),
  hostAct: (kind, amount) => host.act(kind, BigInt(amount), Date.now()),
  hostHandle: (client, msg) => host.handle(client, msg, Date.now()),
  hostDisconnected: client => host.disconnected(client, Date.now()),
  hostTick: () => host.tick(Date.now()),
};

self.onmessage = async e => {
  const {id, op, args = []} = e.data;
  await ready;
  try {
    postMessage({id, result: ops[op](...args)});
  } catch (err) {
    postMessage({id, error: String(err && err.message || err)});
  }
};
