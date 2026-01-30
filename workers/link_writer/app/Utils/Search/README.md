# RagSearch Utility

Shared hybrid-search helper for DreamCatcher.

## Usage
```ts
import { RagSearch } from './Search/RagSearch.js';

const search = new RagSearch({
  prisma,
  embedder: async (q) => myEmbed(q),
  expander: async (q) => [q, `${q} news`, `${q} RSS`],
  options: {
    denseWeight: 0.7,
    sparseWeight: 0.3,
    topK: 20,
    returnK: 5,
  }
});

const results = await search.search('openai');
```

> Note: If no embedder is provided, the search will fall back to sparse (tsvector) only.
