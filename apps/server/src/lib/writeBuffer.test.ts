import test from "node:test";
import assert from "node:assert/strict";
import { coalesce } from "./writeBuffer";

test("coalesce sums duplicate queries in a window", () => {
  const w = coalesce(["a", "b", "a", "a", "c", "b"]);
  assert.equal(w.get("a"), 3);
  assert.equal(w.get("b"), 2);
  assert.equal(w.get("c"), 1);
  assert.equal(w.size, 3);
});

test("coalesce of an empty batch is empty", () => {
  assert.equal(coalesce([]).size, 0);
});
