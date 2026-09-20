'use strict';

/**
 * In-memory de-duplication store.
 *
 * Meta retries unacknowledged deliveries (up to 36 hours for Graph webhooks,
 * up to 7 days for WhatsApp) and retries go to every subscribed app, so
 * duplicate notifications are expected. This store keeps acknowledgement
 * idempotent so the same event is not processed twice.
 *
 * For multi-instance deployments swap this for Redis or a database table while
 * keeping the same `check()` contract.
 */
class DedupeStore {
  constructor(options) {
    const settings = options || {};
    this.ttlMs = settings.ttlMs > 0 ? settings.ttlMs : 10 * 60 * 1000;
    this.maxEntries = settings.maxEntries > 0 ? settings.maxEntries : 5000;
    this.entries = new Map();
  }

  prune(now) {
    for (const entry of this.entries) {
      const key = entry[0];
      const seenAt = entry[1];
      if (now - seenAt > this.ttlMs) this.entries.delete(key);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
    }
  }

  // Returns true when the key was already seen inside the TTL window, meaning
  // the delivery is a duplicate that must not be processed again.
  check(key, now) {
    const timestamp = now || Date.now();
    this.prune(timestamp);
    if (this.entries.has(key)) return true;
    this.entries.set(key, timestamp);
    return false;
  }

  get size() {
    return this.entries.size;
  }

  clear() {
    this.entries.clear();
  }
}

module.exports = { DedupeStore };