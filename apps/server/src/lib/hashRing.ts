/**
 * Consistent hash ring with virtual nodes.
 *
 * A cache key must always map to the *same* node, or a prefix cached on node A
 * is a miss when the next read routes to node B. Round-robin can't do that — it
 * forgets where a key went. Plain `hash % N` is deterministic but remaps almost
 * every key when N changes. A ring with virtual nodes remaps only ~1/N of keys
 * when a node joins or leaves, which is the entire reason to pay for the extra
 * code. Virtual nodes (many ring points per server) smooth the distribution so
 * one server doesn't accidentally own a huge arc.
 *
 * Hash: MurmurHash3 (x86, 32-bit). Cheap, dependency-free, and — unlike a naive
 * hash — has a proper avalanche finalizer, so near-identical vnode ids like
 * `node#0` / `node#1` scatter across the ring instead of clustering. We're
 * placing keys, not defending against an adversary, so a crypto hash would only
 * burn cycles.
 */

export function murmur3(key: string, seed = 0): number {
  const remainder = key.length & 3;
  const bytes = key.length - remainder;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let h1 = seed >>> 0;
  let i = 0;

  while (i < bytes) {
    let k1 =
      (key.charCodeAt(i) & 0xff) |
      ((key.charCodeAt(i + 1) & 0xff) << 8) |
      ((key.charCodeAt(i + 2) & 0xff) << 16) |
      ((key.charCodeAt(i + 3) & 0xff) << 24);
    i += 4;
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;
  }

  let k1 = 0;
  switch (remainder) {
    case 3:
      k1 ^= (key.charCodeAt(i + 2) & 0xff) << 16;
    // falls through
    case 2:
      k1 ^= (key.charCodeAt(i + 1) & 0xff) << 8;
    // falls through
    case 1:
      k1 ^= key.charCodeAt(i) & 0xff;
      k1 = Math.imul(k1, c1);
      k1 = (k1 << 15) | (k1 >>> 17);
      k1 = Math.imul(k1, c2);
      h1 ^= k1;
  }

  // fmix32 — the avalanche step that makes the distribution uniform
  h1 ^= key.length;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;
  return h1 >>> 0;
}

export class HashRing {
  private positions: number[] = []; // ring positions, kept sorted for binary search
  private owner = new Map<number, string>(); // position -> node id
  private nodes = new Set<string>();

  constructor(private readonly vnodes = 160) {}

  addNode(node: string): void {
    if (this.nodes.has(node)) return;
    this.nodes.add(node);
    for (let i = 0; i < this.vnodes; i++) {
      let pos = murmur3(`${node}#${i}`);
      while (this.owner.has(pos)) pos = (pos + 1) >>> 0; // resolve the rare collision
      this.owner.set(pos, node);
      this.positions.splice(this.upperBound(pos), 0, pos);
    }
  }

  removeNode(node: string): void {
    if (!this.nodes.has(node)) return;
    this.nodes.delete(node);
    this.positions = this.positions.filter((p) => this.owner.get(p) !== node);
    for (const [p, n] of this.owner) if (n === node) this.owner.delete(p);
  }

  /** The node that owns `key`: the first virtual node clockwise from its hash. */
  getNode(key: string): string | undefined {
    if (this.positions.length === 0) return undefined;
    const idx = this.upperBound(murmur3(key)) % this.positions.length; // wrap at the top
    return this.owner.get(this.positions[idx]!);
  }

  nodeList(): string[] {
    return [...this.nodes];
  }

  /** How a sample of keys spreads across nodes — the evidence the ring is balanced. */
  distribution(keys: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const n of this.nodes) out[n] = 0;
    for (const k of keys) {
      const n = this.getNode(k);
      if (n) out[n] = (out[n] ?? 0) + 1;
    }
    return out;
  }

  /** Detail behind GET /cache/debug — shows exactly how a key is routed. */
  debug(key: string) {
    const h = murmur3(key);
    const raw = this.positions.length ? this.upperBound(h) : 0;
    const idx = this.positions.length ? raw % this.positions.length : -1;
    return {
      key,
      keyHash: h,
      ownerNode: this.getNode(key) ?? null,
      ringPosition: idx >= 0 ? this.positions[idx]! : null,
      wrappedAround: this.positions.length > 0 && raw === this.positions.length,
      totalVnodes: this.positions.length,
    };
  }

  /** Index of the first ring position strictly greater than `h`. */
  private upperBound(h: number): number {
    let lo = 0;
    let hi = this.positions.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.positions[mid]! <= h) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
