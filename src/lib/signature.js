'use strict';

const crypto = require('node:crypto');

const SUPPORTED_ALGORITHMS = new Set(['sha1', 'sha256']);

// Meta sends the HMAC of the raw request body:
//   X-Hub-Signature-256: sha256=<hex>   (current)
//   X-Hub-Signature:     sha1=<hex>     (legacy, still accepted)
function parseSignatureHeader(header) {
  if (typeof header !== 'string') return null;

  const separator = header.indexOf('=');
  if (separator <= 0) return null;

  const algorithm = header.slice(0, separator).trim().toLowerCase();
  const value = header.slice(separator + 1).trim().toLowerCase();

  if (!SUPPORTED_ALGORITHMS.has(algorithm)) return null;
  if (!/^[a-f0-9]+$/.test(value)) return null;

  return { algorithm, value };
}

function computeSignature(rawBody, appSecret, algorithm) {
  const algo = algorithm || 'sha256';
  if (!SUPPORTED_ALGORITHMS.has(algo)) {
    throw new Error(`Unsupported signature algorithm: ${algo}`);
  }
  return crypto.createHmac(algo, appSecret).update(rawBody).digest('hex');
}

function timingSafeEqualHex(a, b) {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

// Verifies a delivery against the app secret. The raw (unparsed) body must be
// used; re-serializing the parsed JSON changes the bytes and breaks the hash.
function verifySignature(payload) {
  const options = payload || {};
  const rawBody = options.rawBody;
  const appSecret = options.appSecret;

  if (!appSecret) return false;
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return false;

  const parsed = parseSignatureHeader(options.signatureHeader);
  if (!parsed) return false;

  const expected = computeSignature(rawBody, appSecret, parsed.algorithm);
  return timingSafeEqualHex(expected, parsed.value);
}

// Stable identifier for a delivery, used for de-duplication and log correlation.
function hashBody(rawBody) {
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

module.exports = {
  computeSignature,
  parseSignatureHeader,
  verifySignature,
  hashBody,
  SUPPORTED_ALGORITHMS,
};