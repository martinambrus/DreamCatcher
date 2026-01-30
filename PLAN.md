# DreamCatcher LLM News Reader — Detailed Plan (Updated)

## Phase 0 — Repo & Safety Setup
1. Clone DreamCatcher to /root/clawd/DreamCatcher
2. Add .env.example (placeholders only)
3. Ensure .env is gitignored
4. Add startup guard: refuse to run if .env missing
5. Add LLM_PROVIDER=claude|codex
6. Add Z.AI env vars to .env (local only, not committed)

## Phase 1 — Data + Ingestion
7. Keep existing Kafka RSS pipeline (rss-parser stays)
8. Ensure HTML stored (original_body already)
9. Add ingestion status fields: queued → embedded → scored
10. Dedup stays as in DreamCatcher

## Phase 2 — RAG Storage (pgvector‑first)
11. Add pgvector extension
12. Create RAG tables:
   - rag_chunks (children)
   - rag_parents (parents)
   - rag_links (child→parent)
   - rag_metadata
13. Hybrid search (dense + BM25)
   - Dense: pgvector
   - Sparse: Postgres tsvector
   - Weighted merge (RAG_DENSE_WEIGHT / RAG_SPARSE_WEIGHT)

## Phase 3 — Chunking (Hierarchical)
14. Use context‑aware chunking (tree‑sitter)
15. Create parent chunks (larger context)
16. Create child chunks (smaller pieces for search)
17. Store both + linkage

## Phase 4 — Query Expansion
18. On query: generate 3–4 variants
19. Run hybrid search for each
20. Merge + de‑dup results
21. Optionally re‑rank

## Phase 5 — LLM Scoring Worker
22. Implement DreamCatcher analysis worker
23. Build prompt → CLI call (Claude Code via Z.AI)
24. Parse strict JSON → store:
   - score
   - tags
   - reasons
   - entities
25. Add retry on malformed output

## Phase 6 — UI MVP
26. List articles + scores
27. Sort by score
28. Filter by threshold
29. Expand item to show reasoning
30. Display parent context when needed

## Phase 7 — Feedback Loop
31. Like / Dislike / Meh buttons
32. Store explicit reasons
33. Feed reasons into prompt for future scoring

## Phase 8 — Evaluation / Tuning
34. Track accuracy vs your ratings
35. Add reranker toggle (LLM or cross‑encoder)
36. Re‑tune weights (dense vs sparse)
