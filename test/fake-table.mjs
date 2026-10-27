// A stand-in for ducy's MultiTable, for tests that script what a club table
// says: each call (the time left off) is recorded in `calls`, and answered
// by reply(method, args). Use it as clubEngine(MultiTable).
import { clubEngine } from '../src/club-engine.js';

const METHODS = ['handle', 'disconnected', 'newHand', 'advance', 'tick', 'approveChips', 'denyChips', 'remove', 'state', 'resume'];

export function fakeTables(reply) {
  const calls = [];
  class MultiTable {
    static club() { return new MultiTable(); }
    setSitOutLimit() {}
    setMustPlay(client, on) { calls.push({method: 'setMustPlay', args: [client, on]}); return true; }
    free() {}
  }
  for (const m of METHODS) {
    MultiTable.prototype[m] = function (...args) {
      // newHand takes the time first; the others last.
      const time = m === 'newHand' ? args.shift() : args.pop();
      calls.push({method: m, args, time});
      return reply(m, args);
    };
  }
  const engine = clubEngine(MultiTable);
  return {calls, call: async (op, ...args) => engine.ops[op](...args)};
}
