'use strict';

/**
 * Bounded TTL + LRU cache with hit/miss metrics.
 *
 * Used by the TMDB client so repeated catalogue/meta requests don't re-hit the
 * API (protecting against rate limits and keeping the TV snappy). The LRU bound
 * prevents unbounded memory growth on a long-running server; the TTL keeps data
 * reasonably fresh. Entries are evicted lazily on read and on insert overflow.
 */

class TtlLruCache {
  constructor(opts = {}) {
    this.max = opts.max || 1000;
    this.ttl = opts.ttl != null ? opts.ttl : 60 * 60 * 1000; // 1h default
    this.map = new Map(); // key -> { value, expires }
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.expirations = 0;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expires !== 0 && entry.expires <= Date.now()) {
      this.map.delete(key);
      this.expirations++;
      this.misses++;
      return undefined;
    }
    // LRU bump: re-insert to mark as most-recently-used.
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key, value, ttl) {
    const effTtl = ttl != null ? ttl : this.ttl;
    const expires = effTtl > 0 ? Date.now() + effTtl : 0;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires });
    // Evict oldest while over capacity.
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
      this.evictions++;
    }
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      size: this.map.size,
      max: this.max,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? Number((this.hits / total).toFixed(3)) : 0,
      evictions: this.evictions,
      expirations: this.expirations,
    };
  }
}

module.exports = { TtlLruCache };
