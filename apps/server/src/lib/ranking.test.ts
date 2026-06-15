import test from "node:test";
import assert from "node:assert/strict";
import { decay, scoreFor } from "./ranking";

test("decay halves the score after one half-life (default 1800s)", () => {
  assert.ok(Math.abs(decay(100, 1800) - 50) < 1e-6);
});

test("decay is a no-op for non-positive elapsed time", () => {
  assert.equal(decay(42, 0), 42);
  assert.equal(decay(42, -5), 42);
});

test("recency can lift a fresh query over a more popular stale one", () => {
  const fresh = scoreFor("recency", 50, 30); // small, but active now
  const stale = scoreFor("recency", 5000, 0); // big, but silent
  assert.ok(fresh > stale);
  // count mode never does that — popularity always wins
  assert.ok(scoreFor("count", 5000, 0) > scoreFor("count", 50, 30));
});
