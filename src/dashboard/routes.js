'use strict';

const path = require('node:path');
const express = require('express');

// Live dashboard: a small static page plus a Server-Sent Events (SSE) stream.
// Open /dashboard in a browser and every verified webhook delivery appears
// within a second, with the browser Notification API pinging on each arrival.
// Render's Logs tab keeps the full raw server logs; this dashboard is the
// at-a-glance real-time feed (last ~200 events kept in memory).
//
// Auth: when DASHBOARD_TOKEN is set, the browser must send it as
// ?token=... (or an Authorization: Bearer ... header) for the page, the
// stream and the history route. Without a token configured, everything is
// public — convenient for local dev, so set DASHBOARD_TOKEN on Render.
//
// Mounted at /dashboard (page, /stream, /recent). src/app.js also mounts the
// same router at /events as a backwards-compatible alias for the feed.
function createDashboardRouter(options) {
  const config = options.config;
  const eventBus = options.eventBus;

  const router = express.Router();
  // Open SSE responses keep the Node event loop (and the test runner) alive,
  // so track them and expose a closeAll() used by tests on teardown.
  const openStreams = new Set();
  router.closeAllStreams = () => {
    for (const res of [...openStreams]) {
      try {
        res.end();
      } catch {
        // Already closed; nothing to do.
      }
    }
    openStreams.clear();
  };

  function suppliedToken(req) {
    if (req.query && typeof req.query.token === 'string' && req.query.token) {
      return req.query.token;
    }
    const header = req.get('authorization') || '';
    const match = /^Bearer (.+)$/.exec(header.trim());
    return match ? match[1] : '';
  }

  function checkAuth(req, res, next) {
    if (!config.dashboardToken) return next();
    if (suppliedToken(req) === config.dashboardToken) return next();
    if (req.path === '/stream') {
      // SSE clients cannot set headers; reject with an event, not bare JSON.
      res.status(401).type('text/event-stream; charset=utf-8');
      res.write('event: auth_error\n');
      res.write('data: {"error":"unauthorized"}\n\n');
      res.end();
      return;
    }
    res.status(401).json({ error: 'unauthorized', message: 'Set ?token=<DASHBOARD_TOKEN>.' });
  }

  router.get('/', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
  });

  router.get('/recent', checkAuth, (req, res) => {
    res.json({ events: eventBus.recent(req.query.limit || config.recentLimit) });
  });

  // SSE stream: one long-lived text/event-stream response per browser tab.
  router.get('/stream', checkAuth, (req, res) => {
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    openStreams.add(res);

    function send(name, data) {
      res.write(`event: ${name}\n`);
      for (const line of String(data).split('\n')) {
        res.write(`data: ${line}\n`);
      }
      res.write('\n');
    }

    send('ready', JSON.stringify({ ok: true, time: new Date().toISOString() }));

    const unsubscribe = eventBus.subscribe((entry) => {
      const name = entry && entry.type === 'log' ? 'log' : 'webhook';
      try {
        send(name, JSON.stringify(entry));
      } catch {
        // A single bad payload must never kill the stream.
      }
    });

    // Render's proxy/load balancer drops idle connections; heartbeat every
    // 25s keeps the stream alive and lets the browser show "live".
    const heartbeat = setInterval(() => {
      try {
        send('heartbeat', JSON.stringify({ time: new Date().toISOString() }));
      } catch {
        // The close handler below cleans up.
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      openStreams.delete(res);
    });
  });

  return router;
}

module.exports = { createDashboardRouter };