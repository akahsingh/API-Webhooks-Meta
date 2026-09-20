'use strict';

const express = require('express');

const { PRODUCT_META } = require('../products');
const { verifySignature, hashBody } = require('../lib/signature');
const { normalizePayload, summarizeEvents } = require('./normalize');
const { isObject } = require('../lib/json');

// Meta sends JSON payloads up to 3 MB, so keep the ceiling explicit.
const MAX_BODY_BYTES = '3mb';

/**
 * Creates the webhook router.
 *
 * Routes:
 *   GET  /webhooks/:product  -> verification handshake, echoes hub.challenge
 *   POST /webhooks/:product  -> event notifications, validated with
 *                               X-Hub-Signature-256 over the raw body
 *
 * The `onEvents` callback receives every normalized event. The default handler
 * only logs; replace it to store events or reply to messages.
 */
function createWebhookRouter(options) {
  const config = options.config;
  const logger = options.logger;
  const dedupe = options.dedupe;
  const onEvents =
    typeof options.onEvents === 'function'
      ? options.onEvents
      : async () => {};

  const router = express.Router();

  // Raw body is required for HMAC verification, so capture it before parsing.
  const jsonParser = express.json({
    limit: MAX_BODY_BYTES,
    verify: (req, res, buffer) => {
      req.rawBody = buffer;
    },
  });

  router.param('product', (req, res, next, product) => {
    if (!Object.prototype.hasOwnProperty.call(PRODUCT_META, product)) {
      res.status(404).json({
        error: 'unknown_product',
        message: `Unknown webhook product "${product}". Expected one of: pages, whatsapp, instagram.`,
      });
      return;
    }
    req.product = product;
    next();
  });

  // --- Verification handshake -------------------------------------------------
  router.get('/:product', (req, res) => {
    const { product } = req;
    const mode = req.query['hub.mode'];
    const challenge = req.query['hub.challenge'];
    const verifyToken = req.query['hub.verify_token'];
    const expectedToken = config.verifyTokens[product];

    if (!expectedToken) {
      logger.warn('Verification rejected: no verify token configured', { product });
      return res.status(403).json({
        error: 'verify_token_not_configured',
        message: `Set ${PRODUCT_META[product].verifyTokenEnv} (or WEBHOOK_VERIFY_TOKEN) and restart the server.`,
      });
    }

    if (mode !== 'subscribe' || typeof verifyToken !== 'string' || verifyToken !== expectedToken) {
      logger.warn('Verification rejected: token mismatch', { product, mode });
      return res.status(403).json({ error: 'verification_failed' });
    }

    if (challenge === undefined) {
      logger.warn('Verification rejected: hub.challenge missing', { product });
      return res.status(400).json({ error: 'challenge_missing' });
    }

    logger.info('Webhook verified', { product, object: PRODUCT_META[product].object });
    // The challenge must be returned as plain text with status 200.
    return res.status(200).type('text/plain').send(String(challenge));
  });

  // --- Event notifications ----------------------------------------------------
  router.post('/:product', jsonParser, async (req, res) => {
    const { product } = req;
    const signatureHeader = req.get('x-hub-signature-256') || req.get('x-hub-signature');

    if (!config.appSecret && !config.allowUnsignedWebhooks) {
      logger.error('Event rejected: META_APP_SECRET is not configured', {
        product,
        hint: 'Set META_APP_SECRET to the App secret from App Dashboard > App settings > Basic.',
      });
      return res.status(401).json({ error: 'app_secret_not_configured' });
    }

    if (config.appSecret) {
      const signatureValid = verifySignature({
        rawBody: req.rawBody,
        appSecret: config.appSecret,
        signatureHeader,
      });

      if (!signatureValid) {
        logger.warn('Event rejected: invalid signature', {
          product,
          hasSignatureHeader: Boolean(signatureHeader),
          remoteAddress: req.ip,
        });
        return res.status(401).json({ error: 'invalid_signature' });
      }
    } else {
      logger.warn('Event accepted without signature verification', { product });
    }

    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const payload = isObject(req.body) ? req.body : null;

    if (!payload) {
      logger.warn('Event rejected: body is not a JSON object', { product });
      return res.status(400).json({ error: 'invalid_payload' });
    }

    if (isObject(payload.error)) {
      logger.error('Meta reported a payload level error', {
        product,
        errorCode: payload.error.code,
        errorMessage: payload.error.message,
      });
      // Acknowledge: the delivery itself was valid, retrying will not help.
      return res.status(200).json({ received: true, error: true });
    }

    const deliveryHash = hashBody(rawBody);
    const dedupeKey = `${product}:${deliveryHash}`;

    if (dedupe.check(dedupeKey)) {
      logger.info('Duplicate delivery acknowledged', { product, deliveryHash });
      return res.status(200).json({ received: true, duplicate: true });
    }

    const events = normalizePayload(product, payload, {
      includeContent: config.includeMessageContent,
    });

    logger.info('Webhook received', {
      product,
      object: payload.object,
      deliveryHash,
      entryCount: Array.isArray(payload.entry) ? payload.entry.length : 0,
      eventCount: events.length,
      events: summarizeEvents(events),
      signatureVerified: Boolean(config.appSecret),
    });

    if (config.logPayloads) {
      logger.debug('Raw webhook payload', { product, payload });
    }

    // Acknowledge fast: Meta retries (Graph up to 36 hours, WhatsApp up to
    // 7 days) whenever a delivery is not answered with 200 promptly. The event
    // callback keeps running in the background.
    res.status(200).json({ received: true, events: events.length });

    Promise.resolve()
      .then(() => onEvents(events, { product, payload, deliveryHash }))
      .catch((error) => {
        logger.error('Event handler failed', {
          product,
          deliveryHash,
          error: error && error.message ? error.message : String(error),
        });
      });
  });

  // --- Root index: lists the routes so misconfigured URLs are obvious --------
  router.get('/', (req, res) => {
    res.json({
      service: 'meta-webhooks',
      routes: Object.values(PRODUCT_META).map((meta) => ({
        product: meta.path.split('/').pop(),
        object: meta.object,
        callbackPath: meta.path,
        dashboardLocation: meta.dashboardLocation,
      })),
    });
  });

  // JSON parse errors (truncated or oversized bodies) must not crash the server.
  router.use((error, req, res, next) => {
    if (!error) return next();

    const status = error.type === 'entity.too.large' ? 413 : 400;
    logger.warn('Malformed webhook request', {
      product: req.product || null,
      status,
      error: error.message,
    });
    return res.status(status).json({
      error: status === 413 ? 'payload_too_large' : 'invalid_json',
    });
  });

  return router;
}

module.exports = { createWebhookRouter, MAX_BODY_BYTES };