'use strict';

const { redact } = require('./logger');

const DEFAULT_MAX_RECENT = 200;

// In-memory fan-out for the live dashboard. Every normalized webhook delivery
// and every emitted log line is published here; Server-Sent Events subscribers
// receive them in real time and /dashboard/recent serves the trailing window.
// This is intentionally process-local: on Render free/starter plans the service
// runs as a single instance, so all subscribers see the same feed.
function createEventBus(options) {
  const settings = options || {};
  const maxRecent =
    Number.isFinite(settings.maxRecent) && settings.maxRecent > 0
      ? Math.floor(settings.maxRecent)
      : DEFAULT_MAX_RECENT;
  const subscribers = new Set();
  const recent = [];
  let sequence = 0;

  function publish(record) {
    const entry = {
      seq: (sequence += 1),
      time: new Date().toISOString(),
      ...(record || {}),
    };
    // Redact (cap string/array size) and guarantee JSON-serializability so a
    // single odd payload can never break the SSE stream.
    const safe = JSON.parse(JSON.stringify(redact(entry)));
    recent.push(safe);
    if (recent.length > maxRecent) recent.splice(0, recent.length - maxRecent);
    for (const subscriber of [...subscribers]) {
      try {
        subscriber(safe);
      } catch {
        // A slow/broken subscriber must never break webhook delivery.
      }
    }
    return safe;
  }

  function subscribe(listener) {
    subscribers.add(listener);
    return () => {
      subscribers.delete(listener);
    };
  }

  function list(limit) {
    const count =
      Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : maxRecent;
    return recent.slice(-Math.min(count, maxRecent));
  }

  return {
    publish,
    subscribe,
    recent: list,
    clear() {
      recent.length = 0;
    },
    get size() {
      return recent.length;
    },
    get subscriberCount() {
      return subscribers.size;
    },
  };
}

module.exports = { createEventBus, DEFAULT_MAX_RECENT };