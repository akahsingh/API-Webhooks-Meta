'use strict';

// Boots the real HTTP server in-process, then exercises the dashboard exactly
// like a browser + Meta would: handshake, signed delivery, SSE stream, history.
// Usage: node scripts/smoke-dashboard.js

const fs = require('node:fs');

const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { computeSignature } = require('../src/lib/signature');

const APP_SECRET = 'smoke-app-secret';
const VERIFY_TOKEN = 'smoke-verify-token';
const DASHBOARD_TOKEN = 'smoke-dashboard-token';

const PAGES_PAYLOAD = {
  object: 'page',
  entry: [
    {
      id: 'PAGE_1',
      time: 1789000000,
      changes: [
        {
          field: 'feed',
          value: { item: 'comment', verb: 'add', post_id: 'PAGE_1_9', from: { id: 'USER_9' } },
        },
      ],
      messaging: [
        {
          sender: { id: 'USER_10' },
          recipient: { id: 'PAGE_1' },
          message: { mid: 'm_SMOKE_1', text: 'hello' },
        },
      ],
    },
  ],
};

const results = [];

// console.log is asynchronous when stdout is piped, so a later process.exit()
// can truncate the report. writeSync keeps the summary intact on Windows.
function print(line) {
  try {
    fs.writeSync(1, `${line}\n`);
  } catch {
    console.log(line);
  }
}

function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail: detail === undefined ? '' : String(detail) });
}

// Collects SSE frames into the shared array as they arrive.
function startCollector(response, frames) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at = buffer.indexOf('\n\n');
        while (at !== -1) {
          const frame = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          frames.push({
            name: (/^event: (.+)$/m.exec(frame) || [])[1],
            data: [...frame.matchAll(/^data: (.*)$/gm)].map((m) => m[1]).join('\n'),
          });
          at = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // Stream cancelled at the end of the run.
    }
  })();
}

async function main() {
  const config = loadConfig({
    PORT: '0',
    HOST: '127.0.0.1',
    META_APP_SECRET: APP_SECRET,
    WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
    DASHBOARD_TOKEN,
    DASHBOARD_RECENT_LIMIT: '50',
    LOG_LEVEL: 'info',
  });

  const { app, eventBus, closeDashboardStreams } = createApp({ config });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  // The SSE stream below stays open on purpose. Without aborting it (and
  // closing the router's streams) server.close() waits on the live socket
  // forever and the results are never printed.
  const streamAbort = new AbortController();

  try {
    const health = await (await fetch(`${base}/health`)).json();
    check('GET /health -> ok', health.status === 'ok', JSON.stringify(health));

    const noToken = await fetch(`${base}/dashboard`);
    check('GET /dashboard without token -> 401', noToken.status === 401, noToken.status);

    const page = await fetch(`${base}/dashboard?token=${DASHBOARD_TOKEN}`);
    const html = await page.text();
    check(
      'GET /dashboard with token -> HTML page',
      page.status === 200 && html.includes('Meta Webhooks'),
      `${page.status}, ${html.length} bytes`
    );

    for (const product of ['pages', 'whatsapp', 'instagram']) {
      const res = await fetch(
        `${base}/webhooks/${product}?hub.mode=subscribe&hub.challenge=CHAL-${product}&hub.verify_token=${VERIFY_TOKEN}`
      );
      const body = await res.text();
      check(`handshake ${product}`, res.status === 200 && body === `CHAL-${product}`, `${res.status} ${body}`);
    }

    const stream = await fetch(`${base}/dashboard/stream?token=${DASHBOARD_TOKEN}`, {
      signal: streamAbort.signal,
    });
    check(
      'GET /dashboard/stream -> event-stream',
      stream.status === 200 && /text\/event-stream/.test(stream.headers.get('content-type')),
      stream.headers.get('content-type')
    );
    const frames = [];
    startCollector(stream, frames);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const body = JSON.stringify(PAGES_PAYLOAD);
    const post = await fetch(`${base}/webhooks/pages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': `sha256=${computeSignature(body, APP_SECRET)}`,
      },
      body,
    });
    const postBody = await post.json();
    check('signed POST accepted with 2 events', post.status === 200 && postBody.events === 2, JSON.stringify(postBody));

    await new Promise((resolve) => setTimeout(resolve, 400));
    const webhookFrames = () => frames.filter((frame) => frame.name === 'webhook');
    check('SSE sent the ready frame', frames.some((frame) => frame.name === 'ready'), frames.length);
    check('SSE pushed 2 live webhook frames', webhookFrames().length === 2, webhookFrames().length);

    const firstFrame = webhookFrames()[0] ? JSON.parse(webhookFrames()[0].data) : {};
    check(
      'live frame carries product + kind',
      firstFrame.product === 'pages' && firstFrame.kind === 'change',
      JSON.stringify(firstFrame)
    );

    const recent = await (await fetch(`${base}/dashboard/recent?limit=10&token=${DASHBOARD_TOKEN}`)).json();
    check(
      'GET /dashboard/recent returns typed events',
      recent.events.some((entry) => entry.type === 'webhook' && entry.product === 'pages'),
      recent.events.map((entry) => entry.type || entry.level).join(',')
    );

    const bad = await fetch(`${base}/webhooks/pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=deadbeef' },
      body,
    });
    check('tampered signature -> 401', bad.status === 401, bad.status);

    const retry = await fetch(`${base}/webhooks/pages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': `sha256=${computeSignature(body, APP_SECRET)}`,
      },
      body,
    });
    check('duplicate retry flagged as duplicate', (await retry.json()).duplicate === true, 'duplicate');

    await new Promise((resolve) => setTimeout(resolve, 250));
    check('duplicate produced no extra SSE frame', webhookFrames().length === 2, webhookFrames().length);
    check('one SSE subscriber still attached', eventBus.subscriberCount === 1, eventBus.subscriberCount);
  } finally {
    streamAbort.abort();
    closeDashboardStreams();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    // Never let one lingering keep-alive socket hide the report.
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  const failed = results.filter((row) => !row.ok);
  for (const row of results) {
    print(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}${row.detail ? `  [${row.detail}]` : ''}`);
  }
  print('');
  print(`${results.length - failed.length}/${results.length} smoke checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Smoke run crashed:', error);
  process.exit(1);
});