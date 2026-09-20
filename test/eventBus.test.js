'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createEventBus, DEFAULT_MAX_RECENT } = require('../src/lib/eventBus');
const {
  createPublishingLogger,
  createPublishingEventHandler,
} = require('../src/lib/live');

test('publish assigns a sequence and timestamp and notifies subscribers', () => {
  const bus = createEventBus();
  const received = [];
  const unsubscribe = bus.subscribe((entry) => received.push(entry));

  const first = bus.publish({ type: 'webhook', product: 'pages' });
  const second = bus.publish({ type: 'webhook', product: 'whatsapp' });

  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.ok(Date.parse(first.time) > 0);
  assert.deepEqual(received, [first, second]);
  assert.equal(bus.size, 2);
  assert.equal(bus.subscriberCount, 1);

  unsubscribe();
  assert.equal(bus.subscriberCount, 0);
});

test('a throwing subscriber never breaks publishing', () => {
  const bus = createEventBus();
  bus.subscribe(() => {
    throw new Error('slow client');
  });

  const entry = bus.publish({ type: 'log', message: 'hello' });
  assert.equal(entry.message, 'hello');
  assert.equal(bus.size, 1);
});

test('recent keeps only the trailing window and honors limits', () => {
  const bus = createEventBus({ maxRecent: 3 });

  for (let index = 0; index < 10; index += 1) {
    bus.publish({ type: 'webhook', n: index });
  }

  assert.equal(bus.size, 3);
  assert.deepEqual(
    bus.recent().map((entry) => entry.n),
    [7, 8, 9]
  );
  assert.deepEqual(
    bus.recent(2).map((entry) => entry.n),
    [8, 9]
  );
  // Invalid limits fall back to the full window.
  assert.equal(bus.recent('nope').length, 3);
});

test('invalid maxRecent falls back to the default window', () => {
  assert.equal(createEventBus({ maxRecent: 0 }).recent('x').length, 0);
  assert.equal(DEFAULT_MAX_RECENT, 200);
  const bus = createEventBus({ maxRecent: -5 });
  bus.publish({ a: 1 });
  assert.equal(bus.size, 1);
});

test('long strings are capped so one payload cannot flood the stream', () => {
  const bus = createEventBus();
  const entry = bus.publish({ type: 'log', message: 'x'.repeat(5000) });

  assert.ok(entry.message.length < 5000);
  assert.match(entry.message, /\.\.\.\(\d+ chars\)$/);
});

test('clear empties the recent window but keeps the sequence', () => {
  const bus = createEventBus();
  bus.publish({ a: 1 });
  bus.clear();

  assert.equal(bus.size, 0);
  assert.deepEqual(bus.recent(), []);
  assert.equal(bus.publish({ a: 2 }).seq, 2);
});

test('createPublishingLogger still logs and also publishes', () => {
  const calls = [];
  const base = {
    level: 'info',
    debug: (message, meta) => calls.push(['debug', message, meta]),
    info: (message, meta) => calls.push(['info', message, meta]),
    warn: (message, meta) => calls.push(['warn', message, meta]),
    error: (message, meta) => calls.push(['error', message, meta]),
  };
  const bus = createEventBus();
  const logger = createPublishingLogger(base, bus);

  logger.info('Webhook received', { product: 'pages' });
  logger.warn('slow', { ms: 12 });

  assert.deepEqual(calls, [
    ['info', 'Webhook received', { product: 'pages' }],
    ['warn', 'slow', { ms: 12 }],
  ]);
  assert.deepEqual(
    bus.recent().map((entry) => [entry.type, entry.level, entry.message]),
    [
      ['log', 'info', 'Webhook received'],
      ['log', 'warn', 'slow'],
    ]
  );
});

test('createPublishingLogger without a bus returns the original logger', () => {
  const base = { level: 'info', info() {} };
  assert.equal(createPublishingLogger(base, null), base);
});

test('createPublishingEventHandler publishes webhook-shaped entries first', async () => {
  const bus = createEventBus();
  const handled = [];
  const handler = createPublishingEventHandler(
    async (events, context) => handled.push([events, context]),
    bus
  );

  const events = [{ kind: 'message', messageId: 'm1' }];
  const context = { product: 'whatsapp', deliveryHash: 'abc' };
  await handler(events, context);

  assert.equal(handled.length, 1);
  const published = bus.recent();
  assert.equal(published.length, 1);
  assert.equal(published[0].type, 'webhook');
  assert.equal(published[0].product, 'whatsapp');
  assert.equal(published[0].deliveryHash, 'abc');
  assert.equal(published[0].messageId, 'm1');
});

test('createPublishingEventHandler still calls through when publishing throws', async () => {
  const brokenBus = {
    publish() {
      throw new Error('bus down');
    },
  };
  let called = false;
  const handler = createPublishingEventHandler(async () => {
    called = true;
  }, brokenBus);

  await handler([{ kind: 'message' }], { product: 'pages' });
  assert.equal(called, true);
});

test('createPublishingEventHandler defaults to a no-op handler', async () => {
  const bus = createEventBus();
  const handler = createPublishingEventHandler(undefined, bus);
  await handler([{ kind: 'change' }], { product: 'instagram' });
  assert.equal(bus.size, 1);
});

test('createPublishingEventHandler records a delivery card for empty events', async () => {
  const bus = createEventBus();
  const handled = [];
  const handler = createPublishingEventHandler(
    async (events, context) => handled.push([events, context]),
    bus
  );

  await handler([], { product: 'pages', deliveryHash: 'deadbeef' });

  assert.equal(handled.length, 1);
  const published = bus.recent();
  assert.equal(published.length, 1);
  assert.equal(published[0].type, 'webhook');
  assert.equal(published[0].product, 'pages');
  assert.equal(published[0].kind, 'delivery');
  assert.equal(published[0].eventCount, 0);
});