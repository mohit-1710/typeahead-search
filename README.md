# typeahead-search

Search autocomplete service: prefix suggestions ranked by popularity, served
from a distributed cache (consistent hashing) sitting in front of an in-memory
trie, with searches written back to Postgres in batches.

Work in progress — HLD assignment.

## stack

- backend — Fastify + TypeScript
- cache — Redis, 3 nodes, consistent hashing
- store — Postgres
- frontend — Next.js

## dev (so far)

```bash
docker compose up -d
pnpm install
pnpm dev:server   # http://localhost:8080/health
```
