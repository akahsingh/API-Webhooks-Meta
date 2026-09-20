'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { computeSignature } = require('../src/lib/signature');

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';
const DASHBOARD_TOKEN = 'test-dashboard-token';

const silentLogger = {
  level: 'silent',
  debug() {},
  info() {},
  warn() {},
  error() {},
};

async function startServer(t, envOverrides) {
  const { app, eventBus, closeDashboardStreams } = createApp({
    config: loadConfig(envOverrides || {}),
    logger: silentLogger,
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => {
    // End open SSE streams first; otherwise server.close() never finishes.
    if (typeof closeDashboardStreams === 'function') closeDashboardStreams();
    return new Promise((resolve) => server.close(resolve));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, eventBus };
}

test('GET /dashboard serves the live dashboard page', async (t) => {
  const { baseUrl } = await startServer(t, {});
  const response = await fetch(`${baseUrl}/dashboard`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /html/);
  assert.match(html, /Meta Webhooks — Live/);
  assert.match(html, /dashboard\/stream/);
});

test('dashboard auth requires the token when DASHBOARD_TOKEN is set', async (t) => {
  const { baseUrl } = await startServer(t, { DASHBOARD_TOKEN });

  const denied = await fetch(`${baseUrl}/dashboard`);
  assert.equal(denied.status, 401);

  const wrong = await fetch(`${baseUrl}/dashboard?token=wrong`);
  assert.equal(wrong.status, 401);

  const allowed = await fetch(`${baseUrl}/dashboard?token=${DASHBOARD_TOKEN}`);
  assert.equal(allowed.status, 200);

  const headerAllowed = await fetch(`${baseUrl}/dashboard/recent`, {
    headers: { Authorization: `Bearer ${DASHBOARD_TOKEN}` },
  });
  assert.equal(headerAllowed.status, 200);

  const headerDenied = await fetch(`${baseUrl}/dashboard/recent`);
  assert.equal(headerDenied.status, 401);
});

test('GET /dashboard/recent returns the trailing window', async (t) => {
  const { baseUrl, eventBus } = await startServer(t, {});

  assert.deepEqual((await (await fetch(`${baseUrl}/dashboard/recent`)).json()).events, []);

  eventBus.publish({ type: 'log', level: 'info', message: 'hello' });
  eventBus.publish({ type: 'webhook', product: 'pages', kind: 'change' });

  const body = await (await fetch(`${baseUrl}/dashboard/recent?limit=1`)).json();
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].product, 'pages');
});

test('a verified delivery shows up in the dashboard history', async (t) => {
  const { baseUrl } = await startServer(t, {
    META_APP_SECRET: APP_SECRET,
    WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
  });

  // An empty entry array mirrors Meta's "Test" button: zero normalized events,
  // but the dashboard still records a visible delivery card proving arrival.
  const payload = {
    object: 'page',
    entry: [],
  };
  const body = JSON.stringify(payload);
  const response = await fetch(`${baseUrl}/webhooks/pages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': `sha256=${computeSignature(body, APP_SECRET)}`,
    },
    body,
  });
  assert.equal(response.status, 200);

  let recent = { events: [] };
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    recent = await (await fetch(`${baseUrl}/dashboard/recent`)).json();
    if (recent.events.some((entry) => entry.type === 'webhook')) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const types = recent.events.map((entry) => entry.type);
  assert.ok(types.includes('webhook'), `expected a webhook entry, got ${JSON.stringify(types)}`);
});

test('the SSE stream emits ready then live webhook entries', async (t) => {
  const { baseUrl, eventBus } = await startServer(t, {});

  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/dashboard/stream`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const seen = [];

  // Publish after subscribing so the entry travels down the open stream.
  setTimeout(() => {
    eventBus.publish({ type: 'webhook', product: 'instagram', kind: 'mention' });
  }, 50);

  const deadline = Date.now() + 5000;
  try {
    while (Date.now() < deadline && seen.length < 2) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const name = (/^event: (.+)$/m.exec(frame) || [])[1];
        const dataLines = [...frame.matchAll(/^data: (.*)$/gm)].map((m) => m[1]);
        if (name) seen.push({ name, data: dataLines.join('\n') });
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    // Abort the fetch: reader.cancel() alone does not release the socket.
    controller.abort();
    try {
      await reader.cancel();
    } catch {
      // Already torn down; safe to ignore.
    }
  }

  const names = seen.map((frame) => frame.name);
  assert.ok(names.includes('ready'), `expected a ready frame, got ${JSON.stringify(names)}`);
  assert.ok(names.includes('webhook'), `expected a webhook frame, got ${JSON.stringify(names)}`);
  const webhook = JSON.parse(seen.find((frame) => frame.name === 'webhook').data);
  assert.equal(webhook.product, 'instagram');
  assert.equal(webhook.kind, 'mention');
});

test('the index and health endpoints advertise the dashboard', async (t) => {
  const { baseUrl } = await startServer(t, { DASHBOARD_TOKEN });

  const index = await (await fetch(`${baseUrl}/`)).json();
  assert.equal(index.dashboard.path, '/dashboard');
  assert.equal(index.dashboard.stream, '/dashboard/stream');
  assert.equal(index.dashboard.protected, true);

  const health = await (await fetch(`${baseUrl}/health`)).json();
  assert.equal(typeof health.dashboardSubscribers, 'number');
  assert.equal(typeof health.recentEvents, 'number');
});