import test from "node:test";
import assert from "node:assert/strict";
import { HashRing, murmur3 } from "./hashRing";

test("the same key always routes to the same node", () => {
  const ring = new HashRing();
  ["a", "b", "c"].forEach((n) => ring.addNode(n));
  const node = ring.getNode("hello");
  for (let i = 0; i < 100; i++) assert.equal(ring.getNode("hello"), node);
});

test("keys spread roughly evenly across nodes", () => {
  const ring = new HashRing();
  ["n1", "n2", "n3"].forEach((n) => ring.addNode(n));
  const keys = Array.from({ length: 6000 }, (_, i) => `prefix-${i}`);
  const counts = Object.values(ring.distribution(keys));
  // 2000 each is perfect; virtual nodes should keep us within ~30%
  assert.ok(Math.min(...counts) > 1400, `min share too low: ${Math.min(...counts)}`);
  assert.ok(Math.max(...counts) < 2600, `max share too high: ${Math.max(...counts)}`);
});

test("removing a node only remaps the keys it owned", () => {
  const ring = new HashRing();
  ["n1", "n2", "n3"].forEach((n) => ring.addNode(n));
  const keys = Array.from({ length: 5000 }, (_, i) => `k${i}`);
  const before = new Map(keys.map((k) => [k, ring.getNode(k)]));
  ring.removeNode("n2");

  let moved = 0;
  for (const k of keys) {
    if (before.get(k) !== ring.getNode(k)) moved++;
    assert.notEqual(ring.getNode(k), "n2"); // nothing still points at the dead node
  }
  // only keys that lived on n2 (~1/3) should move — nowhere near a full remap
  assert.ok(moved < keys.length * 0.45, `too many keys moved: ${moved}`);
});

test("murmur3 is deterministic and unsigned 32-bit", () => {
  assert.equal(murmur3("abc"), murmur3("abc"));
  assert.ok(murmur3("abc") >= 0 && murmur3("abc") <= 0xffffffff);
  assert.notEqual(murmur3("abc"), murmur3("abd"));
});
