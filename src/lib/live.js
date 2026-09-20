'use strict';

// Bridges the logger + webhook pipeline into the in-memory event bus that
// powers the live dashboard (SSE) and the /events/recent history endpoint.
// Every log line and every verified webhook event is published, so the
// dashboard updates in real time with no polling.
function createPublishingLogger(logger, eventBus) {
  if (!eventBus) return logger;

  function emit(level, message, meta) {
    try {
      eventBus.publish({ type: 'log', level, message, ...(meta && typeof meta === 'object' ? meta : {}) });
    } catch {
      // Publishing must never break logging or webhook delivery.
    }
  }

  return {
    level: logger.level,
    debug: (message, meta) => {
      logger.debug(message, meta);
      emit('debug', message, meta);
    },
    info: (message, meta) => {
      logger.info(message, meta);
      emit('info', message, meta);
    },
    warn: (message, meta) => {
      logger.warn(message, meta);
      emit('warn', message, meta);
    },
    error: (message, meta) => {
      logger.error(message, meta);
      emit('error', message, meta);
    },
  };
}

// Wraps the event handler so normalized webhook events are published to the
// dashboard before the normal handler (log / reply / store) runs.
function createPublishingEventHandler(onEvents, eventBus) {
  const handler = typeof onEvents === 'function' ? onEvents : async () => {};
  if (!eventBus) return handler;

  return async function publishThenHandle(events, context) {
    const meta = context || {};
    try {
      const list = Array.isArray(events) ? events : [];
      if (list.length === 0) {
        // An empty entry array (Meta "Test" button, unsubscribed field) still
        // produces a visible feed card so the dashboard proves the delivery
        // arrived instead of showing nothing.
        eventBus.publish({
          type: 'webhook',
          product: meta.product || 'unknown',
          kind: 'delivery',
          deliveryHash: meta.deliveryHash,
          entryCount: 0,
          eventCount: 0,
          note: 'Delivery contained no entries (test ping or unsubscribed field).',
        });
      }
      for (const event of list) {
        eventBus.publish({
          type: 'webhook',
          product: event.product || meta.product,
          deliveryHash: meta.deliveryHash,
          ...event,
        });
      }
    } catch {
      // Publishing must never break delivery.
    }
    return handler(events, context);
  };
}

module.exports = { createPublishingLogger, createPublishingEventHandler };