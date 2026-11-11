import { test } from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { CHAT_MAX, addChat, chatLimiter, chatName, cleanChat } from '../src/table-chat.js';
import { chatPid, isMuted, mutedList, onMuteChange, readMuted, setMuted, shownChat } from '../src/chat-mute.js';

test('a chat message is trimmed, flattened to one line and cut short', () => {
  assert.equal(cleanChat('  nice   hand\n\tsir  '), 'nice hand sir');
  assert.equal(cleanChat('a\u0000b\u0007c'), 'a b c');
  assert.equal(cleanChat('   '), '');
  assert.equal(cleanChat(null), '');
  assert.equal(cleanChat('x'.repeat(500)).length, CHAT_MAX);
  // Cut by characters, so an emoji isn't split in half.
  assert.equal([...cleanChat('🂡'.repeat(300))].length, CHAT_MAX);
});

test('names on chat lines are short, with a fallback', () => {
  assert.equal(chatName('Allen'), 'Allen');
  assert.equal(chatName(''), 'A player');
  assert.equal(chatName('n'.repeat(40)).length, 20);
});

// A localStorage stand-in.
const memStore = () => { const m = new Map(); return {getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v))}; };

test('muting hides a player’s lines by ID, on this device only (#616)', () => {
  const store = memStore();
  assert.deepEqual(readMuted(store), {});
  setMuted('pidB', 'Bea', true, store);
  const muted = readMuted(store);
  assert.ok(isMuted('pidB', muted));
  assert.ok(!isMuted('pidA', muted));
  assert.ok(!isMuted(undefined, muted), 'a line without an ID always shows');
  const log = [{from: 'Ann', text: '1', pid: 'pidA'}, {from: 'Bea', text: '2', pid: 'pidB'}, {from: 'Bea2', text: '3', pid: 'pidB'}, {from: 'Old', text: '4'}];
  // By ID: Bea renamed is still muted; someone else called Bea isn't.
  assert.deepEqual(shownChat(log, muted).map(m => m.text), ['1', '4']);
  assert.deepEqual(mutedList(store), [{pid: 'pidB', name: 'Bea'}]);
  setMuted('pidB', '', false, store);
  assert.deepEqual(readMuted(store), {});
  assert.deepEqual(shownChat(log, readMuted(store)).map(m => m.text), ['1', '2', '3', '4']);
});

test('the mute list survives bad storage and tells the table when it changes (#616)', () => {
  const store = memStore();
  store.setItem('ducyChatMuted', 'not json');
  assert.deepEqual(readMuted(store), {});
  store.setItem('ducyChatMuted', JSON.stringify({'ok_1': 'Cy', 'bad id!': 'x', n: 5}));
  assert.deepEqual(readMuted(store), {ok_1: 'Cy'});
  setMuted('bad id!', 'x', true, store);
  assert.deepEqual(readMuted(store), {ok_1: 'Cy'}, 'not an ID: ignored');
  let calls = 0;
  const off = onMuteChange(() => calls++);
  setMuted('pidZ', 'Zed', true, store);
  setMuted('pidZ', 'Zed', false, store);
  off();
  setMuted('pidZ', 'Zed', true, store);
  assert.equal(calls, 2);
  assert.deepEqual(mutedList(store).map(m => m.name), ['Cy', 'Zed']);
  assert.equal(chatPid('x'.repeat(65)), '');
});

test('the chat log keeps the newest messages', () => {
  let log = [];
  for (let i = 0; i < 60; i++) log = addChat(log, {from: 'a', text: String(i), at: i});
  assert.equal(log.length, 50);
  assert.equal(log[0].text, '10');
  assert.equal(log.at(-1).text, '59');
});

test('the host lets each player send a few messages at a time', () => {
  const lim = chatLimiter(3, 1000);
  assert.ok(lim.allow('a', 0));
  assert.ok(lim.allow('a', 10));
  assert.ok(lim.allow('a', 20));
  assert.ok(!lim.allow('a', 30), 'a fourth message within the window waits');
  assert.ok(lim.allow('b', 30), 'someone else still can');
  assert.ok(lim.allow('a', 1001), 'the oldest one has aged out');
});
