'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { computeSignature } = require('../src/lib/signature');

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';

const silentLogger = {
  level: 'silent',
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const PAGES_PAYLOAD = {
  object: 'page',
  entry: [
    {
      id: 'PAGE_1',
      time: 1789000000,
      changes: [
        {
          field: 'feed',
          value: { item: 'post', verb: 'add', post_id: 'PAGE_1_1', from: { id: 'USER_1' } },
        },
      ],
    },
  ],
};

// Starts the app on an ephemeral port and records everything the handler sees.
async function startServer(t, envOverrides, options) {
  const received = [];
  const { app, dedupe } = createApp({
    config: loadConfig(envOverrides || {}),
    logger: silentLogger,
    onEvents: async (events, context) => {
      received.push({ events, context });
    },
    ...(options || {}),
  });

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });

  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
      })
  );

  return {
    received,
    dedupe,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
}

function signedRequest(baseUrl, product, payload, secret) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return fetch(`${baseUrl}/webhooks/${product}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': `sha256=${computeSignature(body, secret || APP_SECRET)}`,
    },
    body,
  });
}

// A short delay lets the fire-and-forget event callback finish before asserting.
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

test('GET /health reports an ok status', async (t) => {
  const { baseUrl } = await startServer(t, {});
  const response = await fetch(`${baseUrl}/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.dedupeEntries, 'number');
});

test('GET / lists the three callback endpoints', async (t) => {
  const { baseUrl } = await startServer(t, {
    PUBLIC_BASE_URL: 'https://example.test',
  });
  const body = await (await fetch(`${baseUrl}/`)).json();

  assert.deepEqual(
    body.endpoints.map((endpoint) => endpoint.callbackUrl),
    [
      'https://example.test/webhooks/pages',
      'https://example.test/webhooks/whatsapp',
      'https://example.test/webhooks/instagram',
    ]
  );
  assert.equal(body.signatureVerificationEnforced, true);
});

for (const product of ['pages', 'whatsapp', 'instagram']) {
  test(`GET /webhooks/${product} completes the verification handshake`, async (t) => {
    const { baseUrl } = await startServer(t, { WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN });
    const response = await fetch(
      `${baseUrl}/webhooks/${product}?hub.mode=subscribe&hub.challenge=1158201444&hub.verify_token=${VERIFY_TOKEN}`
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), '1158201444');
  });
}

test('verification accepts a product specific token', async (t) => {
  const { baseUrl } = await startServer(t, {
    WEBHOOK_VERIFY_TOKEN: 'shared',
    WHATSAPP_VERIFY_TOKEN: 'whatsapp-only',
  });

  const ok = await fetch(
    `${baseUrl}/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=42&hub.verify_token=whatsapp-only`
  );
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '42');

  const sharedOnPages = await fetch(
    `${baseUrl}/webhooks/pages?hub.mode=subscribe&hub.challenge=43&hub.verify_token=shared`
  );
  assert.equal(sharedOnPages.status, 200);
});

test('verification rejects a wrong token, missing challenge and wrong mode', async (t) => {
  const { baseUrl } = await startServer(t, { WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN });

  const wrongToken = await fetch(
    `${baseUrl}/webhooks/pages?hub.mode=subscribe&hub.challenge=1&hub.verify_token=nope`
  );
  assert.equal(wrongToken.status, 403);
  assert.equal((await wrongToken.json()).error, 'verification_failed');

  const wrongMode = await fetch(
    `${baseUrl}/webhooks/pages?hub.mode=unsubscribe&hub.challenge=1&hub.verify_token=${VERIFY_TOKEN}`
  );
  assert.equal(wrongMode.status, 403);

  const missingChallenge = await fetch(
    `${baseUrl}/webhooks/pages?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}`
  );
  assert.equal(missingChallenge.status, 400);

  const noTokenConfigured = await startServer(t, {});
  const unconfigured = await fetch(
    `${noTokenConfigured.baseUrl}/webhooks/pages?hub.mode=subscribe&hub.challenge=1&hub.verify_token=anything`
  );
  assert.equal(unconfigured.status, 403);
  assert.equal((await unconfigured.json()).error, 'verify_token_not_configured');
});

test('unknown products return 404 for GET and POST', async (t) => {
  const { baseUrl } = await startServer(t, {
    META_APP_SECRET: APP_SECRET,
    WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
  });

  const get = await fetch(`${baseUrl}/webhooks/tiktok?hub.mode=subscribe&hub.challenge=1`);
  assert.equal(get.status, 404);
  assert.equal((await get.json()).error, 'unknown_product');

  const post = await signedRequest(baseUrl, 'tiktok', PAGES_PAYLOAD);
  assert.equal(post.status, 404);
});

test('a correctly signed delivery is acknowledged and passed to the handler', async (t) => {
  const { baseUrl, received } = await startServer(t, {
    META_APP_SECRET: APP_SECRET,
    WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
  });

  const response = await signedRequest(baseUrl, 'pages', PAGES_PAYLOAD);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.received, true);
  assert.equal(body.events, 1);
  assert.equal(body.duplicate, undefined);

  await settle();
  assert.equal(received.length, 1);
  assert.equal(received[0].events.length, 1);
  assert.equal(received[0].events[0].field, 'feed');
  assert.equal(received[0].events[0].postId, 'PAGE_1_1');
  assert.equal(received[0].context.product, 'pages');
  assert.match(received[0].context.deliveryHash, /^[a-f0-9]{64}$/);
});

test('signature verification rejects a tampered body and a missing header', async (t) => {
  const { baseUrl, received } = await startServer(t, {
    META_APP_SECRET: APP_SECRET,
    WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
  });

  const body = JSON.stringify(PAGES_PAYLOAD);
  const tampered = `${body} `;

  const tamperedResponse = await fetch(`${baseUrl}/webhooks/pages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': `sha256=${computeSignature(body, APP_SECRET)}`,
    },
    body: tampered,
  });
  assert.equal(tamperedResponse.status, 401);
  assert.equal((await tamperedResponse.json()).error, 'invalid_signature');

  const wrongSecret = await signedRequest(baseUrl, 'pages', PAGES_PAYLOAD, 'other-secret');
  assert.equal(wrongSecret.status, 401);

  const unsigned = await fetch(`${baseUrl}/webhooks/pages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  assert.equal(unsigned.status, 401);

  await settle();
  assert.equal(received.length, 0);
});

test('a delivery is rejected when no app secret is configured', async (t) => {
  const { baseUrl, received } = await startServer(t, { WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN });

  const response = await fetch(`${baseUrl}/webhooks/pages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(PAGES_PAYLOAD),
  });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'app_secret_not_configured');

  await settle();
  assert.equal(received.length, 0);
});

test('ALLOW_UNSIGNED_WEBHOOKS accepts unsigned deliveries for local testing', async (t) => {
  const { baseUrl, received } = await startServer(t, {
    ALLOW_UNSIGNED_WEBHOOKS: 'true',
    WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
  });

  const response = await fetch(`${baseUrl}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
  });

  assert.equal(response.status, 200);
  await settle();
  assert.equal(received.length, 1);
});

test('identical retries are acknowledged as duplicates without re-handling', async (t) => {
  const { baseUrl, received, dedupe } = await startServer(t, {
    META_APP_SECRET: APP_SECRET,
    WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
  });

  const first = await signedRequest(baseUrl, 'pages', PAGES_PAYLOAD);
  const second = await signedRequest(baseUrl, 'pages', PAGES_PAYLOAD);

  assert.equal((await first.json()).duplicate, undefined);
  assert.equal((await second.json()).duplicate, true);

  await settle();
  assert.equal(received.length, 1, 'the handler must run once per unique delivery');
  assert.equal(dedupe.size, 1);

  // A different payload is a different delivery.
  const third = await signedRequest(baseUrl, 'pages', {
    ...PAGES_PAYLOAD,
    entry: [{ ...PAGES_PAYLOAD.entry[0], time: 1789000999 }],
  });
  assert.equal(third.status, 200);
  await settle();
  assert.equal(received.length, 2);
});

test('meta error payloads are acknowledged without reaching the handler', async (t) => {
  const { baseUrl, received } = await startServer(t, {
    META_APP_SECRET: APP_SECRET,
    WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
  });

  const response = await signedRequest(baseUrl, 'whatsapp', {
    error: { code: 190, message: 'Access token expired' },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.error, true);

  await settle();
  assert.equal(received.length, 0);
});

test('malformed JSON is rejected with 400 instead of crashing', async (t) => {
  const { baseUrl } = await startServer(t, {
    META_APP_SECRET: APP_SECRET,
    WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
  });

  const response = await signedRequest(baseUrl, 'pages', '{"object":"page",');

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_json');
});

test('unknown paths return a helpful 404', async (t) => {
  const { baseUrl } = await startServer(t, {});
  const response = await fetch(`${baseUrl}/nope`);
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error, 'not_found');
  assert.ok(body.availablePaths.includes('/webhooks/whatsapp'));
});

test('the handler runs even when it is slow, because ack is sent first', async (t) => {
  let handlerFinished = false;
  const { baseUrl } = await startServer(
    t,
    { META_APP_SECRET: APP_SECRET, WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN },
    {
      onEvents: async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        handlerFinished = true;
      },
    }
  );

  const startedAt = Date.now();
  const response = await signedRequest(baseUrl, 'pages', PAGES_PAYLOAD);
  const elapsed = Date.now() - startedAt;

  assert.equal(response.status, 200);
  assert.ok(elapsed < 150, `expected a fast ack, took ${elapsed}ms`);
  assert.equal(handlerFinished, false);

  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(handlerFinished, true);
});