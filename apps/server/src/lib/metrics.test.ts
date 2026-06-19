import test from "node:test";
import assert from "node:assert/strict";
import { percentile } from "./metrics";

test("percentile picks the expected sample from 1..100", () => {
  const s = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(s, 0), 1);
  assert.equal(percentile(s, 95), 95);
  assert.equal(percentile(s, 99), 99);
  assert.equal(percentile(s, 100), 100);
});

test("percentile of an empty set is zero", () => {
  assert.equal(percentile([], 95), 0);
});
