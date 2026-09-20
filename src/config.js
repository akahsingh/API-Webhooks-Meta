'use strict';

const { PRODUCTS, PRODUCT_META } = require('./products');

// Graph API v26.0 was released 2026-07-29 and is the newest version.
// Override with GRAPH_API_VERSION when Meta ships a newer one.
const DEFAULT_GRAPH_VERSION = 'v26.0';

const DEFAULT_DEDUPE_TTL_MS = 10 * 60 * 1000;

function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readBoolean(value, fallback) {
  const normalized = readString(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback === undefined ? false : fallback;
}

function readPositiveNumber(value, fallback) {
  const parsed = Number(readString(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Builds runtime configuration from an env-like object.
// Passing an explicit object keeps every module unit-testable.
function loadConfig(env) {
  const source = env || process.env;
  const sharedVerifyToken = readString(source.WEBHOOK_VERIFY_TOKEN);

  const config = {
    port: readPositiveNumber(source.PORT, 3000),
    host: readString(source.HOST) || '0.0.0.0',
    publicBaseUrl: readString(source.PUBLIC_BASE_URL),
    logLevel: readString(source.LOG_LEVEL).toLowerCase() || 'info',
    logJson: readBoolean(source.LOG_JSON, false),
    logPayloads: readBoolean(source.LOG_WEBHOOK_PAYLOADS, false),
    includeMessageContent: readBoolean(source.INCLUDE_MESSAGE_CONTENT, false),
    appSecret: readString(source.META_APP_SECRET),
    graphVersion: readString(source.GRAPH_API_VERSION) || DEFAULT_GRAPH_VERSION,
    allowUnsignedWebhooks: readBoolean(source.ALLOW_UNSIGNED_WEBHOOKS, false),
    dedupeTtlMs: readPositiveNumber(source.WEBHOOK_DEDUPE_TTL_MS, DEFAULT_DEDUPE_TTL_MS),
    dashboardToken: readString(source.DASHBOARD_TOKEN),
    recentLimit: readPositiveNumber(source.DASHBOARD_RECENT_LIMIT, 200),
    verifyTokens: {},
    subscriptions: {},
  };

  config.verifyTokens.pages = readString(source.PAGES_VERIFY_TOKEN) || sharedVerifyToken;
  config.verifyTokens.whatsapp =
    readString(source.WHATSAPP_VERIFY_TOKEN) || sharedVerifyToken;
  config.verifyTokens.instagram =
    readString(source.INSTAGRAM_VERIFY_TOKEN) || sharedVerifyToken;

  config.subscriptions.pages = {
    appId: readString(source.META_APP_ID),
    resourceId: readString(source.PAGE_ID),
    accessToken: readString(source.PAGE_ACCESS_TOKEN),
    subscribedFields:
      readString(source.PAGES_SUBSCRIBED_FIELDS) ||
      PRODUCT_META.pages.defaultSubscribedFields,
  };

  config.subscriptions.whatsapp = {
    appId: readString(source.META_APP_ID),
    resourceId: readString(source.WABA_ID),
    phoneNumberId: readString(source.WHATSAPP_PHONE_NUMBER_ID),
    accessToken: readString(source.WHATSAPP_SYSTEM_USER_TOKEN),
    subscribedFields:
      readString(source.WHATSAPP_SUBSCRIBED_FIELDS) ||
      PRODUCT_META.whatsapp.defaultSubscribedFields,
  };

  const requestedLoginMode =
    readString(source.INSTAGRAM_LOGIN_MODE).toLowerCase() || 'instagram';
  config.subscriptions.instagram = {
    loginMode: requestedLoginMode === 'facebook' ? 'facebook' : 'instagram',
    appId: readString(source.META_APP_ID),
    resourceId: readString(source.INSTAGRAM_USER_ID),
    accessToken: readString(source.INSTAGRAM_ACCESS_TOKEN),
    subscribedFields:
      readString(source.INSTAGRAM_SUBSCRIBED_FIELDS) ||
      PRODUCT_META.instagram.defaultSubscribedFields,
  };

  return config;
}

function normalizeBaseUrl(value) {
  return readString(value).replace(/\/+$/, '');
}

function buildCallbackPath(product) {
  return PRODUCT_META[product].path;
}

function buildCallbackUrl(publicBaseUrl, product) {
  const base = normalizeBaseUrl(publicBaseUrl);
  return base ? `${base}${buildCallbackPath(product)}` : '';
}

// Startup diagnostics: missing settings plus the exact callback URL that must be
// pasted into the App Dashboard for each product.
function describeConfig(config) {
  const warnings = [];

  if (!config.appSecret && !config.allowUnsignedWebhooks) {
    warnings.push(
      'META_APP_SECRET is missing: POST events are rejected with 401 because X-Hub-Signature-256 cannot be verified.'
    );
  } else if (!config.appSecret) {
    warnings.push(
      'META_APP_SECRET is missing while ALLOW_UNSIGNED_WEBHOOKS=true: payloads are accepted without signature verification. Local testing only.'
    );
  }

  for (const product of PRODUCTS) {
    if (!config.verifyTokens[product]) {
      warnings.push(
        `${PRODUCT_META[product].verifyTokenEnv} (or WEBHOOK_VERIFY_TOKEN) is missing: verification GET requests for ${product} are rejected with 403.`
      );
    }
  }

  if (!config.publicBaseUrl) {
    warnings.push(
      'PUBLIC_BASE_URL is not set: callback URLs are not printed on startup. Set it to your HTTPS tunnel or domain.'
    );
  }

  const products = PRODUCTS.map((product) => ({
    product,
    label: PRODUCT_META[product].label,
    object: PRODUCT_META[product].object,
    dashboardLocation: PRODUCT_META[product].dashboardLocation,
    callbackPath: buildCallbackPath(product),
    callbackUrl: buildCallbackUrl(config.publicBaseUrl, product) || null,
    verifyTokenConfigured: Boolean(config.verifyTokens[product]),
  }));

  return { warnings, products };
}

module.exports = {
  loadConfig,
  describeConfig,
  buildCallbackPath,
  buildCallbackUrl,
  DEFAULT_GRAPH_VERSION,
  DEFAULT_DEDUPE_TTL_MS,
};