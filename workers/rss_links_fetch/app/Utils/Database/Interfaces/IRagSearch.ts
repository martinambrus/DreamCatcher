import { PrismaClient } from '@prisma/client';

/**
 * Async embedding function for dense (pgvector) search.
 * Returns a vector embedding for the provided text.
 */
export type EmbeddingFn = (text: string) => Promise<number[]>;

/**
 * Optional query expander for multi-query hybrid search.
 * Returns an array of additional query variants to merge with the original.
 */
export type ExpandFn = (query: string) => Promise<string[]>;

/**
 * Options controlling hybrid RAG search behavior.
 */
export interface RagSearchOptions {
  /** Weight applied to dense search score (pgvector). */
  denseWeight?: number;
  /** Weight applied to sparse search score (tsvector). */
  sparseWeight?: number;
  /** Top-K rows pulled from each dense/sparse pass. */
  topK?: number;
  /** Final number of results returned after merging. */
  returnK?: number;
  /** Postgres text search language for `plainto_tsquery` (default: english). */
  language?: string;
}

/**
 * Normalized hybrid search result (dense + sparse).
 */
export interface RagSearchResult {
  id: number;
  parent_id: number;
  source_path: string;
  content: string;
  score: number;
  dense_score?: number;
  sparse_score?: number;
}

/**
 * Minimal interface for a RAG search implementation.
 */
export interface IRagSearch {
  search(query: string): Promise<RagSearchResult[]>;
}

/**
 * Dependency container for RagSearch.
 */
export interface RagSearchDeps {
  /** Prisma client connected to the DreamCatcher database. */
  prisma: PrismaClient;
  /** Optional dense embedder. If omitted, only sparse search is performed. */
  embedder?: EmbeddingFn;
  /** Optional query expander for multi-query hybrid search. */
  expander?: ExpandFn;
  /** Optional search tuning parameters. */
  options?: RagSearchOptions;
}
