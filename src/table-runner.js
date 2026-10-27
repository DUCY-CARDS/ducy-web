// One club table's loop (#452): ducy's engine table (MultiTable.club) and
// everything that happens there with time: the turn clock, the next hand,
// away players' moves, fair deals (#136), idle seats (#421), the wait for
// people after a restart (#107), and the clock that stops while no one can
// be reached. It has no timers and no I/O: every event comes with the time,
// and the step it returns says what happened and when to wake it next. The
// club (club-host.js) keeps the money, the members and the transport.
// ducy-play's runner is ported from this: the same events in, the same
// steps out.
//
// Events, {type, ...}:
//   cmd {id, cmd, online}  a member's table command (a join carries their
//                          club name), and whether they're connected
//   disconnected {id}      a member's page left the table
//   presence {id, on}      a member is connected to the relay, or not
//   link {ok}              the host can reach the relay, or not
//   chips {seat, ok}       the club's answer to a chip request
//   remove {seat}          stand a seat up: now between hands, else when the hand ends
//   leaving {id, on}       a member is being stood up (no idle checks for them), or not any more
//   mustPlay {id, on}      the hit-and-run rule holds them: sitting out blinds them off
//   open {on}              the table deals new hands (false: it's closing)
//   state                  the engine's state, as it is
//   wake                   the time the last step asked for came
// Each returns a step, {actions, wake, stopped, paused}: the actions in
// order, the time to send `wake` (null: no need), whether the clock is
// stopped, and whether a restored table is waiting for its people. Actions:
//   {type: 'engine', res}      an engine result; res.out has each member's update
//   {type: 'send', to, update} a table update for a member
//   {type: 'active', id, at}   a member's last activity, for their seat's record
//   {type: 'idle', id}         idle too long: the club stands them up

export const NEXT_HAND_MS = 3000;
export const BOT_PACE_MS = 700;
// Fair deals (#136): how long players have to send a commitment, then a
// reveal, and how long a deal may wait for a round still under way before
// going ahead without one.
export const FAIR_STEP_MS = 4000;
export const FAIR_WAIT_MS = 6000;
const FAIR_RETRY_MS = 300;
// Results kept per player, to send again when they come back.
const FAIR_KEEP = 3;
// A table restored after the host restarted (#107) waits this long for the
// people at it to come back; then whoever isn't back counts as
// disconnected, and the clocks run again.
export const RESUME_GRACE_MS = 60_000;
// Idle seats (#421): how long without a hand, and how long to answer "Still here?".
export const IDLE_MS = 10 * 60_000;
export const ASK_MS = 2 * 60_000;
// While the host can't reach anyone, or a restored table waits, no one is
// stood up; the idle check looks again after this.
const IDLE_RECHECK_MS = 30_000;
// The sit-out limit is checked on tick, so a table with people at it ticks
// this often, not only on the turn clock.
const SWEEP_MS = 5000;
// Table commands that are someone at their app, not their page on its own.
const ACTIVE_CMDS = new Set(['still_here', 'act', 'sit_in', 'request_chips', 'time_bank', 'run_twice']);

const num = v => Number(v);

// `table`: the engine's table. `fair`: ducy's fair-deal functions {secret,
// commitment, seed}. `active`: each seated member's last activity (a
// restored table's, from their seats). `paused`: restored, waiting for its
// people. `link`: whether the host can reach the relay.
export function tableRunner(table, {
  id, game = 'nlhe', fair, open = true, link = true, paused = false, active = {},
  idleMs = IDLE_MS, askMs = ASK_MS,
}) {
  // When each timed thing is next due: tick (the turn clock), sweep,
  // advance (an away player's move), deal, fair (the round's next step),
  // grace (a restored table's wait), idle.
  const due = {};
  let now = 0;
  let actions = [];
  // The engine's clock: real time, less the time it was stopped.
  let stoppedAt = null, lost = 0, stopped = false;
  let linkOk = link, isOpen = open, isPaused = paused;
  const online = new Set(), back = new Set();
  let players = [], view = null, complete = true, handNumber = 0, dealtHand = 0, recorded = 0;
  const activeAt = new Map(Object.entries(active)), asked = new Map(), leaving = new Set();
  let round = null, dealt = null;
  const results = new Map();
  if (isPaused) due.grace = null; // set by the first event: the time comes with it

  const time = () => (stoppedAt ?? now) - lost;
  const send = (to, update) => actions.push({type: 'send', to, update});
  const seated = id => players.some(p => p.client_id === id);

  // Calls the engine, and takes in what it says.
  function engine(method, ...args) {
    const res = method === 'newHand' ? table.newHand(time(), args[0] || undefined) : table[method](...args, time());
    took(res);
    return res;
  }

  function took(res) {
    players = res.players || [];
    for (const d of res.departed || []) {
      activeAt.delete(d.client_id);
      asked.delete(d.client_id);
      leaving.delete(d.client_id);
    }
    view = res.state;
    complete = !!view.complete;
    handNumber = num(view.hand_number);
    // Idle seats: anyone new is counted from now; a hand dealt to them is activity.
    for (const p of players) if (!activeAt.has(p.client_id)) activeAt.set(p.client_id, now);
    if (!complete && handNumber && handNumber !== dealtHand) {
      dealtHand = handNumber;
      for (const p of players) {
        const v = view.seats?.[p.seat];
        if (v && !v.empty && !v.sitting_out && !p.pending) markActive(p.client_id);
      }
    }
    actions.push({type: 'engine', res});
    // A fair-dealt hand's reveals go out after its final state.
    if (complete && handNumber && handNumber !== recorded) {
      recorded = handNumber;
      fairPublish();
    }
    const restarted = syncClock();
    pace(res);
    // Restarted: the state's turn clock and next step set the times again.
    if (restarted) engine('state');
  }

  // Stops or restarts the clock to match who can be reached. Returns
  // whether it restarted.
  function syncClock() {
    const stop = !linkOk || !players.some(p => online.has(p.client_id));
    if (stop === stopped) return false;
    stopped = stop;
    if (stop) {
      stoppedAt = now;
      for (const k of ['tick', 'sweep', 'advance', 'deal', 'fair']) delete due[k];
      round = null;
      return false;
    }
    lost += now - stoppedAt;
    stoppedAt = null;
    return true;
  }

  // What happens next: the clock's or an away player's move, the next hand.
  function pace(res) {
    if (stopped) return;
    delete due.tick;
    if (res.turnMsLeft != null) due.tick = now + num(res.turnMsLeft) + 50;
    if (res.botToAct) due.advance = now + BOT_PACE_MS;
    // A restored table deals no new hand until its people are back.
    if (complete && !isPaused && due.deal == null && isOpen && num(res.playersIn) >= 2) {
      // The next hand's fair-deal round, if one isn't under way already.
      if (!round) fairStart();
      due.deal = now + (handNumber ? NEXT_HAND_MS : 500);
    }
  }

  // Deals the next hand, from the fair-deal round's seed. A round still
  // under way gets a little longer; after that the hand is dealt without
  // one rather than holding the table up.
  function deal() {
    const f = round;
    if (f && !f.seed && now - f.started < FAIR_WAIT_MS) { due.deal = now + FAIR_RETRY_MS; return; }
    round = null;
    // If people left meanwhile the engine refuses; the next change (someone
    // sitting down, chips) tries again.
    let res = null;
    try { res = engine('newHand', f?.seed || null); } catch {}
    if (!res) return;
    if (f?.seed) {
      // Who was dealt in: the players whose view came with their own cards
      // (someone sitting out isn't).
      const dealtIn = new Set((res.out || []).filter(m => m.data?.view?.seats?.[0]?.cards).map(m => m.to));
      dealt = {hand: num(res.state.hand_number), round: f, seats: players.filter(p => dealtIn.has(p.client_id)).map(p => ({id: p.client_id, seat: p.seat}))};
    }
    // The round for the hand after this one runs while this one is played.
    fairStart();
  }

  // ---- fair deals (#136) ----
  //
  // Each seated player's page and the host commit to a random value, then,
  // once every commitment is in (a list everyone gets before revealing),
  // reveal it. The hand is dealt from the seed of all the values revealed,
  // so no single party picks the cards. After the hand the host publishes
  // the reveals, and each page checks its own cards and the board against
  // the seed (fair-check.js). A player who doesn't commit or reveal in time
  // is left out of the seed, so the table never waits on them.

  function fairStart() {
    if (round || !fair) return;
    let host;
    try { host = fair.secret(); } catch (e) { console.warn('fair deal:', e); return; }
    const f = round = {id: `${id}:${now}`, started: now, host, commits: new Map(), reveals: new Map(), seed: null};
    f.invited = new Set(players.map(p => p.client_id));
    for (const to of f.invited) send(to, {type: 'fair', step: 'commit', round: f.id});
    due.fair = now + FAIR_STEP_MS;
  }

  // Every commitment is in (or the time's up): everyone gets the list, then reveals.
  function fairCommitsIn(f) {
    f.list = [{id: 'host', c: f.host.commitment}, ...[...f.commits].map(([id, c]) => ({id, c}))];
    for (const [to] of f.commits) send(to, {type: 'fair', step: 'reveal', round: f.id, list: f.list});
    if (!f.commits.size) { fairRevealsIn(f); return; }
    due.fair = now + FAIR_STEP_MS;
  }

  // Every reveal is in (or the time's up): the seed, from the values in list order.
  function fairRevealsIn(f) {
    delete due.fair;
    f.used = f.list.filter(e => e.id === 'host' || f.reveals.has(e.id))
      .map(e => (e.id === 'host' ? {id: 'host', value: f.host.value, nonce: f.host.nonce} : {id: e.id, ...f.reveals.get(e.id)}));
    try { f.seed = fair.seed(f.used.map(u => u.value)); } catch (e) { console.warn('fair deal:', e); }
  }

  // A player's commitment or reveal for the round under way.
  function fairIncoming(from, cmd) {
    const f = round;
    if (!f || cmd.round !== f.id || !f.invited.has(from)) return;
    const hex = s => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
    if (cmd.type === 'fair_commit' && !f.list && hex(cmd.c) && !f.commits.has(from)) {
      f.commits.set(from, cmd.c);
      if (f.commits.size === f.invited.size) fairCommitsIn(f);
    } else if (cmd.type === 'fair_reveal' && f.list && !f.seed && f.commits.has(from) && !f.reveals.has(from) && hex(cmd.value) && hex(cmd.nonce)) {
      // A reveal that doesn't open its commitment is left out, like a missing one.
      let opens = false;
      try { opens = fair.commitment(cmd.value, cmd.nonce) === f.commits.get(from); } catch {}
      if (!opens) return;
      f.reveals.set(from, {value: cmd.value, nonce: cmd.nonce});
      if (f.reveals.size === f.commits.size) fairRevealsIn(f);
    }
  }

  // A hand dealt from a seed is over: everyone dealt in gets the reveals, so
  // their page can check the deal, with where their cards are in it.
  function fairPublish() {
    const d = dealt;
    if (!d || d.hand !== handNumber) return;
    dealt = null;
    // Cards go to the dealt seats in seat order (ducy's Deal::from_seed).
    const order = d.seats.slice().sort((a, b) => a.seat - b.seat);
    order.forEach((p, index) => {
      const update = {
        type: 'fair', step: 'result', hand: d.hand, game, dealt: order.length, index,
        seed: d.round.seed, list: d.round.list, reveals: d.round.used,
      };
      // Kept for a while, to send again to a player who was away when it went.
      results.set(p.id, [...(results.get(p.id) || []), update].slice(-FAIR_KEEP));
      send(p.id, update);
    });
  }

  // ---- idle seats (#421) ----
  //
  // Someone seated idleMs without being dealt a hand (sitting out, or alone
  // at the table) is stood up. If they're connected they're asked first
  // ("Still here?") and have askMs to say so, which gives them another
  // idleMs. This runs even while the clock is stopped: that's how a seat no
  // one came back to was once held for two weeks.

  // Member `who` did something here (or was dealt a hand): idle from now.
  // If they'd been asked "Still here?", the question goes away.
  function markActive(who) {
    activeAt.set(who, now);
    actions.push({type: 'active', id: who, at: now});
    if (asked.delete(who)) send(who, {type: 'idle', done: true});
  }

  // When the idle check is next due, for whoever's due first.
  function idleDue() {
    let at = Infinity;
    // A closing table stands everyone up anyway.
    if (isOpen) for (const p of players) {
      const who = p.client_id;
      if (leaving.has(who)) continue;
      const a = asked.get(who);
      at = Math.min(at, a != null ? a + askMs : (activeAt.get(who) ?? now) + idleMs);
    }
    if (at === Infinity) return null;
    return !linkOk || isPaused ? Math.max(at, now + IDLE_RECHECK_MS) : at;
  }

  // Asks or stands up whoever's been idle too long.
  function checkIdle() {
    if (!linkOk || isPaused || !isOpen) return;
    for (const p of players) {
      const who = p.client_id;
      if (leaving.has(who) || now - (activeAt.get(who) ?? now) < idleMs) continue;
      const a = asked.get(who);
      if (online.has(who) && a == null) {
        asked.set(who, now);
        send(who, {type: 'idle', secs: Math.round(askMs / 1000)});
        continue;
      }
      if (online.has(who) && now - a < askMs) continue;
      leaving.add(who);
      actions.push({type: 'idle', id: who});
    }
  }

  // ---- after a restart (#107) ----

  // A restored table's clocks run again: everyone not back yet counts as
  // disconnected (they check or fold, and the sit-out limit counts).
  function resume() {
    if (!isPaused) return;
    isPaused = false;
    delete due.grace;
    for (const p of players) if (!back.has(p.client_id)) engine('disconnected', p.client_id);
    engine('resume');
  }

  // Someone at a restored table is back: once everyone is, play goes on.
  function cameBack(who) {
    if (!isPaused) return;
    back.add(who);
    if (players.every(p => back.has(p.client_id))) resume();
  }

  // ---- events ----

  function wake() {
    // Each in turn, if it's due (an earlier one can set or clear a later one).
    const fire = {
      grace: resume,
      fair: () => { if (round && !round.list) fairCommitsIn(round); else if (round && !round.seed) fairRevealsIn(round); },
      tick: () => engine('tick'),
      sweep: () => { if (players.length) engine('tick'); },
      advance: () => engine('advance'),
      deal,
      idle: checkIdle,
    };
    for (const [k, fn] of Object.entries(fire)) {
      if (due[k] == null || due[k] > now) continue;
      delete due[k];
      try { fn(); } catch (e) { console.warn(`table ${id} ${k}:`, e); }
    }
  }

  function cmd(who, c) {
    if (c.type === 'fair_commit' || c.type === 'fair_reveal') { fairIncoming(who, c); return; }
    if (ACTIVE_CMDS.has(c.type) && seated(who)) markActive(who);
    if (c.type === 'still_here') return;
    engine('handle', who, c);
    // Back at a restored table; and the last few hands' fair-deal results
    // again, in case they were away when they went (their page checks each once).
    if (c.type === 'join') {
      cameBack(who);
      for (const update of results.get(who) || []) send(who, update);
    }
  }

  function event(ev, at) {
    now = at;
    actions = [];
    if (due.grace === null) due.grace = now + RESUME_GRACE_MS;
    switch (ev.type) {
      case 'cmd':
        if ('online' in ev) { if (ev.online) online.add(ev.id); else online.delete(ev.id); }
        cmd(ev.id, ev.cmd);
        break;
      case 'disconnected': engine('disconnected', ev.id); break;
      case 'presence':
        if (ev.on) online.add(ev.id); else online.delete(ev.id);
        if (syncClock()) engine('state');
        if (ev.on) cameBack(ev.id);
        break;
      case 'link':
        linkOk = !!ev.ok;
        if (syncClock()) engine('state');
        break;
      case 'chips': engine(ev.ok ? 'approveChips' : 'denyChips', ev.seat); break;
      case 'remove': engine('remove', ev.seat); break;
      case 'leaving': if (ev.on) leaving.add(ev.id); else leaving.delete(ev.id); break;
      case 'mustPlay': table.setMustPlay?.(String(ev.id), !!ev.on, time()); break;
      case 'open': isOpen = !!ev.on; break;
      case 'state': engine('state'); break;
      case 'wake': wake(); break;
      default: throw new Error(`table ${id}: no event ${ev.type}`);
    }
    // A table with people at it ticks regularly, for the sit-out limit. One
    // whose clock is stopped doesn't: the limit doesn't count then anyway.
    if (players.length && !stopped) due.sweep ??= now + SWEEP_MS;
    else delete due.sweep;
    due.idle = idleDue();
    const times = Object.values(due).filter(t => t != null);
    return {actions, wake: times.length ? Math.min(...times) : null, stopped, paused: isPaused};
  }

  return {
    event,
    // The table as JSON, to resume it after a restart (#107); null with an
    // older ducy-wasm.
    save: at => { now = at; return table.save ? table.save(time()) : null; },
    free: () => table.free?.(),
  };
}
