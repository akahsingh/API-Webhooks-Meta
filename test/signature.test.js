'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeSignature,
  parseSignatureHeader,
  verifySignature,
  hashBody,
} = require('../src/lib/signature');

// Known-answer vectors so a future refactor cannot silently weaken the HMAC.
const VECTORS = [
  {
    algorithm: 'sha256',
    body: 'hello',
    secret: 'secret',
    digest: '88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b',
  },
  {
    algorithm: 'sha1',
    body: 'hello',
    secret: 'secret',
    digest: '5112055c05f944f85755efc5cd8970e194e9f45b',
  },
];

test('computeSignature matches known HMAC vectors', () => {
  for (const vector of VECTORS) {
    assert.equal(
      computeSignature(Buffer.from(vector.body), vector.secret, vector.algorithm),
      vector.digest
    );
  }
});

test('computeSignature defaults to sha256 and rejects unknown algorithms', () => {
  assert.equal(
    computeSignature(Buffer.from('hello'), 'secret'),
    VECTORS[0].digest
  );
  assert.throws(() => computeSignature(Buffer.from('hello'), 'secret', 'md5'), /Unsupported/);
});

test('parseSignatureHeader accepts sha1/sha256 and rejects malformed input', () => {
  assert.deepEqual(parseSignatureHeader('sha256=ABC123'), {
    algorithm: 'sha256',
    value: 'abc123',
  });
  assert.deepEqual(parseSignatureHeader('sha1=deadbeef'), {
    algorithm: 'sha1',
    value: 'deadbeef',
  });

  assert.equal(parseSignatureHeader(undefined), null);
  assert.equal(parseSignatureHeader(''), null);
  assert.equal(parseSignatureHeader('sha256'), null);
  assert.equal(parseSignatureHeader('sha256='), null);
  assert.equal(parseSignatureHeader('=abc'), null);
  assert.equal(parseSignatureHeader('md5=deadbeef'), null);
  assert.equal(parseSignatureHeader('sha256=zzzz'), null);
});

test('verifySignature accepts a correct sha256 header', () => {
  const rawBody = Buffer.from(JSON.stringify({ object: 'page', entry: [] }));
  const signatureHeader = `sha256=${computeSignature(rawBody, 'app-secret')}`;

  assert.equal(
    verifySignature({ rawBody, appSecret: 'app-secret', signatureHeader }),
    true
  );
});

test('verifySignature accepts the legacy sha1 header', () => {
  const rawBody = Buffer.from('{"object":"page"}');
  const signatureHeader = `sha1=${computeSignature(rawBody, 'app-secret', 'sha1')}`;

  assert.equal(
    verifySignature({ rawBody, appSecret: 'app-secret', signatureHeader }),
    true
  );
});

test('verifySignature rejects tampered bodies, wrong secrets and missing headers', () => {
  const rawBody = Buffer.from('{"object":"page"}');

  assert.equal(
    verifySignature({
      rawBody: Buffer.from('{"object":"page","tampered":true}'),
      appSecret: 'app-secret',
      signatureHeader: `sha256=${computeSignature(rawBody, 'app-secret')}`,
    }),
    false
  );

  assert.equal(
    verifySignature({
      rawBody,
      appSecret: 'other-secret',
      signatureHeader: `sha256=${computeSignature(rawBody, 'app-secret')}`,
    }),
    false
  );

  assert.equal(verifySignature({ rawBody, appSecret: 'app-secret' }), false);
  assert.equal(verifySignature({ rawBody, appSecret: '', signatureHeader: 'sha256=x' }), false);
  assert.equal(
    verifySignature({ rawBody: Buffer.alloc(0), appSecret: 'app-secret', signatureHeader: 'sha256=x' }),
    false
  );
});

test('hashBody is stable and differs for different bodies', () => {
  const a = hashBody(Buffer.from('{"a":1}'));
  const b = hashBody(Buffer.from('{"a":1}'));
  const c = hashBody(Buffer.from('{"a":2}'));

  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[a-f0-9]{64}$/);
});