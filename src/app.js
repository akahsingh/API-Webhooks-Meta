'use strict';

const express = require('express');

const { PRODUCTS, PRODUCT_META } = require('./products');
const { loadConfig, describeConfig, buildCallbackPath } = require('./config');
const { createLogger } = require('./lib/logger');
const { DedupeStore } = require('./lib/dedupe');
const { createEventBus } = require('./lib/eventBus');
const { createPublishingLogger, createPublishingEventHandler } = require('./lib/live');
const { createWebhookRouter } = require('./webhooks/router');
const { createEventLogger } = require('./webhooks/handlers');
const { createDashboardRouter } = require('./dashboard/routes');

/**
 * Builds the Express app.
 *
 * Accepts overrides (config, logger, dedupe, onEvents) so tests can run the app
 * without touching .env or the network.
 */
function createApp(options) {
  const settings = options || {};
  const config = settings.config || loadConfig();
  const baseLogger =
    settings.logger || createLogger({ level: config.logLevel, json: config.logJson });
  const eventBus =
    settings.eventBus || createEventBus({ maxRecent: config.recentLimit });
  // The default event handler logs through the *publishing* logger, so its
  // "Webhook event / Webhook events handled" lines land on the dashboard as
  // log entries. Fan out the webhook-shaped cards first so the feed shows
  // rich entries (message IDs, senders, statuses), then let the handler run.
  const logger = createPublishingLogger(baseLogger, eventBus);
  const eventsHandler = createPublishingEventHandler(
    settings.onEvents || createEventLogger(logger),
    eventBus
  );
  const dedupe = settings.dedupe || new DedupeStore({ ttlMs: config.dedupeTtlMs });
  const onEvents = eventsHandler;

  const app = express();
  app.disable('x-powered-by');
  // Behind a tunnel (ngrok, Cloudflare) or a load balancer, so req.ip and
  // req.protocol reflect the original client.
  app.set('trust proxy', true);

  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      logger.debug('HTTP request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  });

  const overview = describeConfig(config);

  app.get('/', (req, res) => {
    res.json({
      service: 'meta-webhooks-server',
      status: 'running',
      graphVersion: config.graphVersion,
      appSecretConfigured: Boolean(config.appSecret),
      signatureVerificationEnforced:
        Boolean(config.appSecret) || !config.allowUnsignedWebhooks,
      includeMessageContent: config.includeMessageContent,
      dashboard: {
        path: '/dashboard',
        stream: '/dashboard/stream',
        recent: '/dashboard/recent',
        protected: Boolean(config.dashboardToken),
      },
      endpoints: overview.products.map((product) => ({
        product: product.product,
        label: product.label,
        object: product.object,
        method: 'GET (verify) + POST (events)',
        callbackPath: product.callbackPath,
        callbackUrl: product.callbackUrl,
        verifyTokenConfigured: product.verifyTokenConfigured,
        dashboardLocation: product.dashboardLocation,
      })),
      warnings: overview.warnings,
    });
  });

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      dedupeEntries: dedupe.size,
      dashboardSubscribers: eventBus.subscriberCount,
      recentEvents: eventBus.size,
    });
  });

  // Live dashboard: /dashboard (page) + /dashboard/stream (SSE) +
  // /dashboard/recent (history). Kept before the 404 handler on purpose.
  const dashboardRouter = createDashboardRouter({ config, eventBus });
  app.use('/dashboard', dashboardRouter);
  // Backwards-compatible aliases for the same feed.
  const eventsAliasRouter = createDashboardRouter({ config, eventBus });
  app.use('/events', eventsAliasRouter);

  app.use('/webhooks', createWebhookRouter({ config, logger, dedupe, onEvents }));

  app.use((req, res) => {
    res.status(404).json({
      error: 'not_found',
      message: `No route for ${req.method} ${req.path}.`,
      availablePaths: [
        '/health',
        '/dashboard',
        '/dashboard/stream',
        '/dashboard/recent',
        ...PRODUCTS.map((product) => PRODUCT_META[product].path),
      ],
    });
  });

  app.use((error, req, res, next) => {
    if (!error) return next();
    logger.error('Unhandled request error', {
      method: req.method,
      path: req.path,
      error: error.message,
    });
    res.status(500).json({ error: 'internal_error' });
  });

  app.locals.config = config;
  app.locals.logger = logger;
  app.locals.dedupe = dedupe;
  app.locals.eventBus = eventBus;

  function closeDashboardStreams() {
    for (const router of [dashboardRouter, eventsAliasRouter]) {
      if (router && typeof router.closeAllStreams === 'function') {
        router.closeAllStreams();
      }
    }
  }

  return { app, config, logger, dedupe, eventBus, closeDashboardStreams };
}

module.exports = { createApp, describeConfig, buildCallbackPath };