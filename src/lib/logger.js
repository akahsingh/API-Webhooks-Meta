'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Meta webhooks are high volume and contain personal data, so every log entry
// passes through a redaction step that caps string length and array size.
function redact(value, depth) {
  const level = depth || 0;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > 300 ? `${value.slice(0, 300)}...(${value.length} chars)` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (level > 3) return `[array:${value.length}]`;
    return value.slice(0, 20).map((item) => redact(item, level + 1));
  }
  if (typeof value === 'object') {
    if (level > 3) return '[object]';
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = redact(item, level + 1);
    }
    return out;
  }
  return String(value);
}

function createLogger(options) {
  const settings = options || {};
  const level = LEVELS[settings.level] ? settings.level : 'info';
  const json = Boolean(settings.json);
  const threshold = LEVELS[level];

  function write(levelName, message, meta) {
    if (LEVELS[levelName] < threshold) return;
    const stream =
      levelName === 'error' || levelName === 'warn' ? console.error : console.log;
    const safeMeta = meta ? redact(meta) : undefined;
    const hasMeta = safeMeta && Object.keys(safeMeta).length > 0;

    if (json) {
      stream(
        JSON.stringify({
          time: new Date().toISOString(),
          level: levelName,
          message,
          ...(hasMeta ? { meta: safeMeta } : {}),
        })
      );
      return;
    }

    stream(
      `[${new Date().toISOString()}] ${levelName.toUpperCase()} ${message}${
        hasMeta ? ` ${JSON.stringify(safeMeta)}` : ''
      }`
    );
  }

  return {
    level,
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
  };
}

module.exports = { createLogger, redact, LEVELS };