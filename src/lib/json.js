'use strict';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return undefined;
  }
}

module.exports = { isObject, parseJsonSafe };