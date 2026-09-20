'use strict';

/**
 * Enables webhook notifications for the Page, WhatsApp Business Account (WABA)
 * and Instagram professional account that own the events.
 *
 * Verifying a Callback URL in the App Dashboard only tells Meta where to send
 * events. The receiving asset must also install/subscribe to the app, otherwise
 * no notifications are delivered.
 *
 * Usage:
 *   node scripts/subscribe.js list
 *   node scripts/subscribe.js pages       [subscribe|unsubscribe|list]
 *   node scripts/subscribe.js whatsapp    [subscribe|unsubscribe|list]
 *   node scripts/subscribe.js instagram   [subscribe|unsubscribe|list]
 */

const { loadConfig } = require('../src/config');
const { PRODUCT_META } = require('../src/products');

const GRAPH_FACEBOOK_HOST = 'https://graph.facebook.com';
const GRAPH_INSTAGRAM_HOST = 'https://graph.instagram.com';

const ACTIONS = ['subscribe', 'unsubscribe', 'list'];

function graphHostFor(product, config) {
  if (product === 'instagram' && config.subscriptions.instagram.loginMode === 'instagram') {
    return GRAPH_INSTAGRAM_HOST;
  }
  return GRAPH_FACEBOOK_HOST;
}

// Instagram Login and WhatsApp use a bearer token; Page and Instagram-by-
// Facebook-Login accept access_token as a query parameter.
function usesBearerToken(product, config) {
  if (product === 'whatsapp') return true;
  return product === 'instagram' && config.subscriptions.instagram.loginMode === 'instagram';
}

async function callGraph(options) {
  const url = new URL(
    `${options.host}/${options.version}/${options.path}`
  );

  const headers = { Accept: 'application/json' };
  const init = { method: options.method, headers };

  if (usesBearerToken(options.product, options.config)) {
    headers.Authorization = `Bearer ${options.accessToken}`;
  } else {
    url.searchParams.set('access_token', options.accessToken);
  }

  if (options.method === 'POST') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(options.params || {})) {
      if (value !== undefined && value !== null && value !== '') body.set(key, value);
    }
    init.body = body;
  } else {
    for (const [key, value] of Object.entries(options.params || {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, value);
      }
    }
  }

  const response = await fetch(url, init);
  const text = await response.text();

  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (error) {
    parsed = { raw: text };
  }

  if (!response.ok) {
    const metaError = parsed && parsed.error ? parsed.error : {};
    const detail = metaError.message || parsed.raw || response.statusText;
    const code = metaError.code ? ` (code ${metaError.code})` : '';
    throw new Error(`${options.method} ${url.pathname} failed: HTTP ${response.status}${code} ${detail}`);
  }

  return parsed;
}

function requireSetting(value, name, product) {
  if (value) return value;
  const hint = PRODUCT_META[product].dashboardLocation;
  throw new Error(`${name} is not set in .env (needed for ${product}). See ${hint}.`);
}

async function runAction(product, action, config) {
  const subscription = config.subscriptions[product];
  const host = graphHostFor(product, config);
  const version = config.graphVersion;

  const resourceId = requireSetting(
    subscription.resourceId,
    product === 'pages' ? 'PAGE_ID' : product === 'whatsapp' ? 'WABA_ID' : 'INSTAGRAM_USER_ID',
    product
  );
  const accessToken = requireSetting(
    subscription.accessToken,
    product === 'pages'
      ? 'PAGE_ACCESS_TOKEN'
      : product === 'whatsapp'
        ? 'WHATSAPP_SYSTEM_USER_TOKEN'
        : 'INSTAGRAM_ACCESS_TOKEN',
    product
  );

  const base = {
    product,
    config,
    host,
    version,
    accessToken,
    path: `${resourceId}/subscribed_apps`,
  };

  if (action === 'list') {
    const result = await callGraph({ ...base, method: 'GET' });
    console.log(`\n${PRODUCT_META[product].label} (${resourceId}) via ${host}`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (action === 'unsubscribe') {
    const result = await callGraph({ ...base, method: 'DELETE' });
    console.log(`\nRemoved app subscription for ${product} (${resourceId}):`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const result = await callGraph({
    ...base,
    method: 'POST',
    params: { subscribed_fields: subscription.subscribedFields },
  });

  console.log(`\nSubscribed ${product} (${resourceId}) via ${host}`);
  console.log(`  subscribed_fields: ${subscription.subscribedFields}`);
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  const target = (args[0] || 'list').toLowerCase();
  const action = (args[1] || 'subscribe').toLowerCase();
  const config = loadConfig();

  if (!ACTIONS.includes(action)) {
    throw new Error(`Unknown action "${action}". Use one of: ${ACTIONS.join(', ')}.`);
  }

  if (target === 'list' && args[1] === undefined) {
    for (const product of Object.keys(PRODUCT_META)) {
      const subscription = config.subscriptions[product];
      console.log(`${product.padEnd(10)} resourceId=${subscription.resourceId || '(not set)'} fields=${subscription.subscribedFields}`);
    }
    console.log('\nRun "npm run subscribe:pages" (etc.) to install the app for each asset,');
    console.log('or use "<product> list" to see which apps are currently subscribed.');
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(PRODUCT_META, target)) {
    throw new Error(
      `Unknown product "${target}". Use pages, whatsapp, instagram or list.`
    );
  }

  await runAction(target, action, config);
}

main().catch((error) => {
  console.error(`\nSubscribe failed: ${error.message}\n`);
  process.exitCode = 1;
});