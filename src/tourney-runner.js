// One club tournament's loop (#458), as table-runner.js is a cash table's:
// ducy's ClubTournament and everything that happens there with time: the
// level clock with its breaks, the next hands, absent players' moves, the
// turn clocks, and which tables have just finished a hand. No timers and no
// I/O: every event comes with the time, and the step it returns says what
// happened and when to wake it next. The club (club-tourney-host.js) keeps
// registration, knockouts, prizes, saving and the transport. ducy-play's
// runner is ported from this: the same events in, the same steps out.
//
// Events, {type, ...}:
//   begin                  the level clock starts: at the config's step, with
//                          its time left (resuming), else at the first level
//   cmd {id, cmd}          a player's table command
//   disconnected {id}      a player dropped: blinded off until they're back
//   addEntry {id, name}    a late registration or re-entry, seated now
//   state                  the tournament as it is
//   wake                   the time the last step asked for came
// Each returns a step, {actions, wake, step, stepEndsAt, onBreak, level}: the
// actions in order, the time to send `wake` (null: no need), and the level
// clock: the structure's step, when it ends (null: the last level, which
// stays), whether it's a break, and the level being played. Actions:
//   {type: 'engine', res}        an engine result; res.out has each player's update
//   {type: 'hand', table, view}  a table finished a hand: its spectator view

export const BOT_PACE_MS = 700;
export const NEXT_HAND_MS = 2500;

const num = v => Number(v);

// `t`: the engine's tournament. `structure`: its steps, [{minutes, break?}]
// (a level's blinds are the engine's). `levelMs` replaces every step's
// minutes (tests). `step` and `stepLeftMs`: where a restored one's clock was.
// `hands`: report finished hands.
export function tourneyRunner(t, {
  id, structure, levelMs = null, nextHandMs = NEXT_HAND_MS, botPaceMs = BOT_PACE_MS,
  step = 0, stepLeftMs = null, level = 0, hands = false,
}) {
  const due = {}; // level, advance, deal, tick
  let now = 0, actions = [];
  let cur = step, onBreak = false, lvl = level, stepEndsAt = null, over = false;
  const seen = {}; // table → the last hand reported

  function engine(method, ...args) {
    const res = t[method](...args, now);
    took(res);
    return res;
  }

  function took(res) {
    if (!res) return;
    const ev = res.events || {};
    if (ev.level != null) lvl = num(ev.level);
    if (res.level != null) lvl = num(res.level);
    actions.push({type: 'engine', res});
    // Tables between hands: each one's last hand, once.
    if (hands) for (const x of res.tables || []) if (!x.inHand) handDone(x.id);
    over = !!res.over || !!ev.winner;
    pace(res);
  }

  function handDone(table) {
    const view = t.tableView(table);
    const n = num(view?.hand_number);
    if (!view?.complete || !n || seen[table] === n) return;
    seen[table] = n;
    actions.push({type: 'hand', table, view});
  }

  // What happens next: an absent player's move, the next hands (not during
  // a break), and the turn clocks.
  function pace(res) {
    delete due.advance;
    delete due.deal;
    delete due.tick;
    if (over) { delete due.level; return; }
    if (res.autoToAct) due.advance = now + botPaceMs;
    if (res.canDeal && !onBreak) due.deal = now + nextHandMs;
    const left = (res.tables || []).map(x => x.turnMsLeft).filter(x => x != null).map(num);
    if (left.length) due.tick = now + Math.min(...left) + 50;
  }

  // The level clock: step `i` of the structure (a level, or a break) starts
  // now, or, resuming, goes on with `leftMs` to go. The last level stays
  // once it's reached.
  function startStep(i, leftMs = null) {
    cur = Math.min(i, structure.length - 1);
    const s = structure[cur];
    onBreak = !!s.break;
    const level = structure.slice(0, cur + 1).filter(x => !x.break).length - 1;
    const ms = leftMs ?? levelMs ?? s.minutes * 60_000;
    stepEndsAt = i < structure.length ? now + ms : null;
    delete due.level;
    if (i < structure.length - 1 || s.break) due.level = now + ms;
    if (!onBreak && level !== lvl) engine('setLevel', Math.max(0, level));
    else engine('state');
  }

  function wake() {
    // Each in turn, if it's due.
    const fire = {level: () => startStep(cur + 1), tick: () => engine('tick'), advance: () => engine('advance'), deal: () => engine('newHands')};
    for (const [k, fn] of Object.entries(fire)) {
      if (due[k] == null || due[k] > now || over) continue;
      delete due[k];
      try { fn(); } catch (e) { console.warn(`tournament ${id} ${k}:`, e); }
    }
  }

  function event(ev, at) {
    now = at;
    actions = [];
    switch (ev.type) {
      case 'begin': startStep(step, stepLeftMs); break;
      case 'cmd': engine('handle', ev.id, ev.cmd); break;
      case 'disconnected': engine('disconnected', ev.id); break;
      case 'addEntry': engine('addEntry', ev.id, ev.name); break;
      case 'state': engine('state'); break;
      case 'wake': wake(); break;
      default: throw new Error(`tournament ${id}: no event ${ev.type}`);
    }
    const times = Object.values(due).filter(x => x != null);
    return {actions, wake: times.length ? Math.min(...times) : null, step: cur, stepEndsAt, onBreak, level: lvl};
  }

  return {
    event,
    // The tournament as JSON, to resume it after a restart; null with a
    // ducy-wasm that can't.
    save: at => (t.save ? t.save(at) : null),
    // The host's view of one table (no hole cards until shown down).
    tableView: table => t.tableView(table) ?? null,
    free: () => t.free?.(),
  };
}
