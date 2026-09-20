'use strict';

/**
 * Sends signed sample payloads to the local server.
 *
 * Use this to confirm the endpoint verifies signatures and parses the three
 * payload shapes before wiring anything to the App Dashboard.
 *
 * Usage:
 *   node scripts/send-test-event.js                 # all three products
 *   node scripts/send-test-event.js whatsapp
 *   node scripts/send-test-event.js instagram http://localhost:3000
 *
 * Requires META_APP_SECRET so the request carries a valid
 * X-Hub-Signature-256 header. Set ALLOW_UNSIGNED_WEBHOOKS=true in .env to test
 * without a secret.
 */

const { loadConfig } = require('../src/config');
const { computeSignature } = require('../src/lib/signature');
const { PRODUCT_META } = require('../src/products');

const SAMPLE_PAYLOADS = {
  pages: {
    object: 'page',
    entry: [
      {
        id: 'PAGE_ID_SAMPLE',
        time: 1789000000,
        changes: [
          {
            field: 'feed',
            value: {
              from: { id: 'USER_ID_SAMPLE', name: 'Sample User' },
              item: 'post',
              post_id: 'PAGE_ID_SAMPLE_1234567890',
              verb: 'add',
              created_time: 1789000000,
              is_hidden: false,
              message: 'Sample post body',
            },
          },
        ],
      },
    ],
  },
  whatsapp: {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID_SAMPLE',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550783881',
                phone_number_id: 'PHONE_NUMBER_ID_SAMPLE',
              },
              contacts: [{ profile: { name: 'Sample User' }, wa_id: '16505551234' }],
              messages: [
                {
                  from: '16505551234',
                  id: 'wamid.SAMPLE_INBOUND_ID',
                  timestamp: '1789000000',
                  type: 'text',
                  text: { body: 'Sample inbound message' },
                },
              ],
            },
          },
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550783881',
                phone_number_id: 'PHONE_NUMBER_ID_SAMPLE',
              },
              statuses: [
                {
                  id: 'wamid.SAMPLE_OUTBOUND_ID',
                  status: 'delivered',
                  timestamp: '1789000005',
                  recipient_id: '16505551234',
                  conversation: { id: 'CONVERSATION_ID_SAMPLE' },
                  pricing: { category: 'service' },
                },
              ],
            },
          },
        ],
      },
    ],
  },
  instagram: {
    object: 'instagram',
    entry: [
      {
        id: 'IG_USER_ID_SAMPLE',
        time: 1789000000,
        changes: [
          {
            field: 'comments',
            value: {
              id: 'COMMENT_ID_SAMPLE',
              from: { id: 'IG_SENDER_ID_SAMPLE', username: 'sample_user' },
              media: { id: 'MEDIA_ID_SAMPLE', media_product_type: 'FEED' },
              text: 'Sample comment',
            },
          },
        ],
      },
      {
        id: 'IG_USER_ID_SAMPLE',
        time: 1789000010,
        messaging: [
          {
            sender: { id: 'IG_SENDER_ID_SAMPLE' },
            recipient: { id: 'IG_USER_ID_SAMPLE' },
            timestamp: 1789000010,
            message: { mid: 'IG_MESSAGE_ID_SAMPLE', text: 'Sample direct message' },
          },
        ],
      },
    ],
  },
};

async function send(product, config, baseUrl) {
  const payload = SAMPLE_PAYLOADS[product];
  const body = JSON.stringify(payload);
  const url = `${baseUrl}${PRODUCT_META[product].path}`;

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'meta-webhooks-local-test',
  };

  if (config.appSecret) {
    headers['X-Hub-Signature-256'] = `sha256=${computeSignature(body, config.appSecret, 'sha256')}`;
  }

  const response = await fetch(url, { method: 'POST', headers, body });
  const text = await response.text();

  const status = response.ok ? 'OK ' : 'FAIL';
  console.log(`${status} ${product.padEnd(10)} POST ${url} -> ${response.status} ${text}`);

  if (config.appSecret) {
    console.log(`     signed with sha256 (${headers['X-Hub-Signature-256'].slice(0, 24)}...)`);
  } else {
    console.log('     META_APP_SECRET is not set: request sent unsigned.');
  }

  return response.ok;
}

async function main() {
  const args = process.argv.slice(2);
  const target = (args[0] || 'all').toLowerCase();
  const config = loadConfig();
  const baseUrl = (args[1] || config.publicBaseUrl || `http://localhost:${config.port}`).replace(/\/+$/, '');

  const products =
    target === 'all'
      ? Object.keys(SAMPLE_PAYLOADS)
      : [target];

  for (const product of products) {
    if (!Object.prototype.hasOwnProperty.call(SAMPLE_PAYLOADS, product)) {
      throw new Error(`Unknown product "${product}". Use pages, whatsapp, instagram or all.`);
    }
  }

  const results = [];
  for (const product of products) {
    results.push(await send(product, config, baseUrl));
  }

  if (results.some((ok) => !ok)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nTest event failed: ${error.message}\n`);
  process.exitCode = 1;
});