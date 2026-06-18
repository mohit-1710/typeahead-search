import type { CacheCluster } from "./lib/cache";
import type { Store } from "./lib/store";
import type { CompletionTrie } from "./lib/trie";

/** The live subsystems, handed to each route registrar. */
export interface AppContext {
  trie: CompletionTrie;
  cache: CacheCluster;
  store: Store;
}
