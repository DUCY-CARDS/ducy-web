import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_MAX, addChat, chatLimiter, chatName, cleanChat, readChat } from '../src/table-chat.js';

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

test('a guest reads only well-formed chat messages', () => {
  assert.deepEqual(readChat({type: 'chat', from: 'Ann', text: ' hi ', at: 5}), {from: 'Ann', text: 'hi', at: 5});
  assert.equal(readChat({type: 'chat', from: 'Ann', text: '   '}), null);
  assert.equal(readChat({type: 'state'}), null);
  assert.equal(readChat(null), null);
  assert.equal(readChat({type: 'chat', text: 'hey'}).from, 'A player');
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
