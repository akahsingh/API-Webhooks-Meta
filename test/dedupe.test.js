'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DedupeStore } = require('../src/lib/dedupe');

test('check returns false the first time and true afterwards', () => {
  const store = new DedupeStore({ ttlMs: 60000 });

  assert.equal(store.check('delivery-1'), false);
  assert.equal(store.check('delivery-1'), true);
  assert.equal(store.check('delivery-2'), false);
  assert.equal(store.size, 2);
});

test('entries expire after the ttl window', () => {
  const store = new DedupeStore({ ttlMs: 1000 });
  const start = 1_000_000;

  assert.equal(store.check('delivery-1', start), false);
  assert.equal(store.check('delivery-1', start + 999), true);

  // Past the TTL the delivery is treated as new again.
  assert.equal(store.check('delivery-1', start + 1001), false);
});

test('the store never grows past maxEntries', () => {
  const store = new DedupeStore({ ttlMs: 600000, maxEntries: 3 });

  for (let index = 0; index < 10; index += 1) {
    store.check(`delivery-${index}`);
  }

  assert.ok(store.size <= 3, `expected <= 3 entries, received ${store.size}`);
});

test('invalid constructor options fall back to defaults', () => {
  const store = new DedupeStore({ ttlMs: 0, maxEntries: -5 });

  assert.equal(store.check('a'), false);
  assert.equal(store.check('a'), true);
});

test('clear empties the store', () => {
  const store = new DedupeStore();
  store.check('a');
  store.clear();

  assert.equal(store.size, 0);
  assert.equal(store.check('a'), false);
});