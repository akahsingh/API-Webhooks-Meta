'use strict';

/**
 * The three Meta products this server receives webhooks for.
 * Order matters only for logging output.
 */
const PRODUCTS = ['pages', 'whatsapp', 'instagram'];

const PRODUCT_META = {
  pages: {
    label: 'Facebook Page',
    path: '/webhooks/pages',
    object: 'page',
    verifyTokenEnv: 'PAGES_VERIFY_TOKEN',
    defaultSubscribedFields: 'feed,messages',
    dashboardLocation: 'App Dashboard > Webhooks > Page',
  },
  whatsapp: {
    label: 'WhatsApp Business Account',
    path: '/webhooks/whatsapp',
    object: 'whatsapp_business_account',
    verifyTokenEnv: 'WHATSAPP_VERIFY_TOKEN',
    defaultSubscribedFields: 'messages',
    dashboardLocation: 'App Dashboard > WhatsApp > Configuration',
  },
  instagram: {
    label: 'Instagram professional account',
    path: '/webhooks/instagram',
    object: 'instagram',
    verifyTokenEnv: 'INSTAGRAM_VERIFY_TOKEN',
    defaultSubscribedFields: 'comments,mentions,messages',
    dashboardLocation: 'App Dashboard > Webhooks > Instagram',
  },
};

function isProduct(value) {
  return PRODUCTS.includes(value);
}

module.exports = { PRODUCTS, PRODUCT_META, isProduct };