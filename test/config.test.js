'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadConfig,
  describeConfig,
  buildCallbackUrl,
  buildCallbackPath,
  DEFAULT_GRAPH_VERSION,
  DEFAULT_DEDUPE_TTL_MS,
} = require('../src/config');

test('defaults are applied when nothing is configured', () => {
  const config = loadConfig({});

  assert.equal(config.port, 3000);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.graphVersion, DEFAULT_GRAPH_VERSION);
  assert.equal(config.graphVersion, 'v26.0');
  assert.equal(config.dedupeTtlMs, DEFAULT_DEDUPE_TTL_MS);
  assert.equal(config.allowUnsignedWebhooks, false);
  assert.equal(config.includeMessageContent, false);
  assert.equal(config.appSecret, '');
  assert.equal(config.dashboardToken, '');
  assert.equal(config.recentLimit, 200);
  assert.deepEqual(config.verifyTokens, {
    pages: '',
    whatsapp: '',
    instagram: '',
  });
});

test('an invalid GRAPH_API_VERSION falls back to the default', () => {
  assert.equal(loadConfig({ GRAPH_API_VERSION: '   ' }).graphVersion, DEFAULT_GRAPH_VERSION);
});

test('numbered values are parsed and invalid values ignored', () => {
  const config = loadConfig({ PORT: '8080', WEBHOOK_DEDUPE_TTL_MS: '30000' });
  assert.equal(config.port, 8080);
  assert.equal(config.dedupeTtlMs, 30000);

  const fallback = loadConfig({ PORT: 'not-a-port', WEBHOOK_DEDUPE_TTL_MS: '-1' });
  assert.equal(fallback.port, 3000);
  assert.equal(fallback.dedupeTtlMs, DEFAULT_DEDUPE_TTL_MS);
});

test('dashboard settings are read from env', () => {
  const config = loadConfig({ DASHBOARD_TOKEN: '  secret-token  ', DASHBOARD_RECENT_LIMIT: '50' });
  assert.equal(config.dashboardToken, 'secret-token');
  assert.equal(config.recentLimit, 50);

  const fallback = loadConfig({ DASHBOARD_RECENT_LIMIT: 'nonsense' });
  assert.equal(fallback.dashboardToken, '');
  assert.equal(fallback.recentLimit, 200);
});

test('boolean flags accept common truthy spellings only', () => {
  assert.equal(loadConfig({ ALLOW_UNSIGNED_WEBHOOKS: 'true' }).allowUnsignedWebhooks, true);
  assert.equal(loadConfig({ ALLOW_UNSIGNED_WEBHOOKS: 'YES' }).allowUnsignedWebhooks, true);
  assert.equal(loadConfig({ ALLOW_UNSIGNED_WEBHOOKS: '1' }).allowUnsignedWebhooks, true);
  assert.equal(loadConfig({ ALLOW_UNSIGNED_WEBHOOKS: 'false' }).allowUnsignedWebhooks, false);
  assert.equal(loadConfig({ ALLOW_UNSIGNED_WEBHOOKS: 'nope' }).allowUnsignedWebhooks, false);
});

test('verify tokens fall back to the shared token and can be overridden', () => {
  const shared = loadConfig({ WEBHOOK_VERIFY_TOKEN: 'shared-token' });
  assert.deepEqual(shared.verifyTokens, {
    pages: 'shared-token',
    whatsapp: 'shared-token',
    instagram: 'shared-token',
  });

  const perProduct = loadConfig({
    WEBHOOK_VERIFY_TOKEN: 'shared-token',
    WHATSAPP_VERIFY_TOKEN: 'whatsapp-token',
    INSTAGRAM_VERIFY_TOKEN: 'instagram-token',
  });
  assert.equal(perProduct.verifyTokens.pages, 'shared-token');
  assert.equal(perProduct.verifyTokens.whatsapp, 'whatsapp-token');
  assert.equal(perProduct.verifyTokens.instagram, 'instagram-token');
});

test('subscription defaults are product specific', () => {
  const config = loadConfig({});

  assert.equal(config.subscriptions.pages.subscribedFields, 'feed,messages');
  assert.equal(config.subscriptions.whatsapp.subscribedFields, 'messages');
  assert.equal(config.subscriptions.instagram.subscribedFields, 'comments,mentions,messages');
  assert.equal(config.subscriptions.instagram.loginMode, 'instagram');
});

test('instagram login mode only accepts known values', () => {
  assert.equal(
    loadConfig({ INSTAGRAM_LOGIN_MODE: 'facebook' }).subscriptions.instagram.loginMode,
    'facebook'
  );
  assert.equal(
    loadConfig({ INSTAGRAM_LOGIN_MODE: 'FACEBOOK' }).subscriptions.instagram.loginMode,
    'facebook'
  );
  assert.equal(
    loadConfig({ INSTAGRAM_LOGIN_MODE: 'nonsense' }).subscriptions.instagram.loginMode,
    'instagram'
  );
});

test('subscription settings are read from env', () => {
  const config = loadConfig({
    META_APP_ID: '111',
    PAGE_ID: '222',
    PAGE_ACCESS_TOKEN: 'page-token',
    PAGES_SUBSCRIBED_FIELDS: 'feed',
    WABA_ID: '333',
    WHATSAPP_PHONE_NUMBER_ID: '444',
    WHATSAPP_SYSTEM_USER_TOKEN: 'wa-token',
    INSTAGRAM_USER_ID: '555',
    INSTAGRAM_ACCESS_TOKEN: 'ig-token',
  });

  assert.deepEqual(config.subscriptions.pages, {
    appId: '111',
    resourceId: '222',
    accessToken: 'page-token',
    subscribedFields: 'feed',
  });
  assert.equal(config.subscriptions.whatsapp.resourceId, '333');
  assert.equal(config.subscriptions.whatsapp.phoneNumberId, '444');
  assert.equal(config.subscriptions.whatsapp.accessToken, 'wa-token');
  assert.equal(config.subscriptions.instagram.resourceId, '555');
  assert.equal(config.subscriptions.instagram.accessToken, 'ig-token');
});

test('callback paths and urls are built per product', () => {
  assert.equal(buildCallbackPath('pages'), '/webhooks/pages');
  assert.equal(buildCallbackPath('whatsapp'), '/webhooks/whatsapp');
  assert.equal(buildCallbackPath('instagram'), '/webhooks/instagram');

  assert.equal(
    buildCallbackUrl('https://abc.ngrok-free.app/', 'pages'),
    'https://abc.ngrok-free.app/webhooks/pages'
  );
  assert.equal(buildCallbackUrl('', 'instagram'), '');
  assert.equal(buildCallbackUrl('   ', 'instagram'), '');
});

test('describeConfig reports missing app secret and verify tokens', () => {
  const overview = describeConfig(loadConfig({}));

  assert.equal(overview.products.length, 3);
  assert.ok(overview.warnings.some((warning) => warning.includes('META_APP_SECRET')));
  assert.ok(overview.warnings.some((warning) => warning.includes('PAGES_VERIFY_TOKEN')));
  assert.ok(overview.warnings.some((warning) => warning.includes('PUBLIC_BASE_URL')));
  assert.ok(
    overview.warnings.some((warning) =>
      warning.includes('ALLOW_UNSIGNED_WEBHOOKS=true')
    ) === false,
    'the unsigned-warning must not appear while the flag is false'
  );
});

test('describeConfig warns loudly when signature checks are disabled', () => {
  const overview = describeConfig(loadConfig({ ALLOW_UNSIGNED_WEBHOOKS: 'true' }));
  assert.ok(
    overview.warnings.some((warning) =>
      warning.includes('accepted without signature verification')
    )
  );
});

test('describeConfig lists the expected callback URLs when everything is set', () => {
  const overview = describeConfig(
    loadConfig({
      META_APP_SECRET: 'secret',
      WEBHOOK_VERIFY_TOKEN: 'token',
      PUBLIC_BASE_URL: 'https://example.test/',
    })
  );

  assert.deepEqual(
    overview.products.map((product) => [product.product, product.callbackUrl, product.verifyTokenConfigured]),
    [
      ['pages', 'https://example.test/webhooks/pages', true],
      ['whatsapp', 'https://example.test/webhooks/whatsapp', true],
      ['instagram', 'https://example.test/webhooks/instagram', true],
    ]
  );
  assert.deepEqual(overview.warnings, []);
});