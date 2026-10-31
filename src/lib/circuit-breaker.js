'use strict';

/**
 * Minimal circuit breaker.
 *
 * Protects the TV experience during an upstream (TMDB) outage: after a run of
 * consecutive failures the breaker "opens" and short-circuits calls for a
 * cooldown window, so we fail fast and serve stale data instead of hammering a
 * struggling API and making every row spin. After the cooldown it moves to
 * "half-open" and lets one trial through; success closes it, failure re-opens.
 *
 * States: closed (normal) -> open (short-circuit) -> half-open (trial) -> closed.
 */

class CircuitBreaker {
  constructor(opts = {}) {
    this.threshold = opts.threshold || 5; // consecutive failures to open
    this.cooldownMs = opts.cooldownMs || 30 * 1000;
    this.now = opts.now || (() => Date.now());
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = 0;
    this.trips = 0;
  }

  /** Can a request proceed right now? Transitions open -> half-open on cooldown. */
  canRequest() {
    if (this.state === 'open') {
      if (this.now() - this.openedAt >= this.cooldownMs) {
        this.state = 'half-open';
        return true;
      }
      return false;
    }
    return true; // closed or half-open
  }

  recordSuccess() {
    this.failures = 0;
    this.state = 'closed';
  }

  recordFailure() {
    this.failures++;
    if (this.state === 'half-open' || this.failures >= this.threshold) {
      if (this.state !== 'open') this.trips++;
      this.state = 'open';
      this.openedAt = this.now();
    }
  }

  stats() {
    return { state: this.state, failures: this.failures, trips: this.trips };
  }
}

module.exports = { CircuitBreaker };
