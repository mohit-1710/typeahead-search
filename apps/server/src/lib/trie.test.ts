import test from "node:test";
import assert from "node:assert/strict";
import { CompletionTrie } from "./trie";

test("returns completions for a prefix, ranked by count", () => {
  const trie = new CompletionTrie();
  trie.build([
    { query: "cat", count: 50 },
    { query: "car", count: 90 },
    { query: "card", count: 30 },
    { query: "cab", count: 10 },
    { query: "dog", count: 100 },
  ]);
  assert.deepEqual(
    trie.getSuggestions("ca", 10).map((s) => s.query),
    ["car", "cat", "card", "cab"],
  );
  assert.deepEqual(
    trie.getSuggestions("car", 10).map((s) => s.query),
    ["car", "card"],
  );
});

test("a prefix that matches nothing returns empty", () => {
  const trie = new CompletionTrie();
  trie.build([{ query: "apple", count: 5 }]);
  assert.deepEqual(trie.getSuggestions("z", 10), []);
  assert.deepEqual(trie.getSuggestions("", 10), []);
});

test("respects the K limit", () => {
  const trie = new CompletionTrie();
  trie.build([
    { query: "aa", count: 1 },
    { query: "ab", count: 2 },
    { query: "ac", count: 3 },
  ]);
  assert.equal(trie.getSuggestions("a", 2).length, 2);
});

test("incremental updates re-rank an existing query", () => {
  const trie = new CompletionTrie();
  trie.build([
    { query: "react", count: 100 },
    { query: "redux", count: 10 },
  ]);
  assert.equal(trie.getSuggestions("re", 1)[0]?.query, "react");
  trie.applyIncrements(new Map([["redux", 500]]));
  assert.equal(trie.getSuggestions("re", 1)[0]?.query, "redux");
});

test("a brand new query becomes searchable", () => {
  const trie = new CompletionTrie();
  trie.build([{ query: "go", count: 5 }]);
  trie.applyIncrements(new Map([["golang", 3]]));
  assert.deepEqual(
    trie.getSuggestions("gol", 5).map((s) => s.query),
    ["golang"],
  );
});
