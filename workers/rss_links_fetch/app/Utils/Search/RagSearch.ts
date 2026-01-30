import { PrismaClient } from '@prisma/client';
import { IRagSearch, RagSearchDeps, RagSearchOptions, RagSearchResult } from './Interfaces/IRagSearch.js';

export class RagSearch implements IRagSearch {
  private prisma: PrismaClient;
  private embedder?: (text: string) => Promise<number[]>;
  private expander?: (query: string) => Promise<string[]>;
  private options: RagSearchOptions;

  /**
   * Hybrid RAG search helper that merges sparse (tsvector) and dense (pgvector)
   * results into a single ranked list.
   *
   * @param {RagSearchDeps} deps Dependency container (Prisma + optional embedder/expander).
   */
  constructor({ prisma, embedder, expander, options }: RagSearchDeps) {
    this.prisma = prisma;
    this.embedder = embedder;
    this.expander = expander;
    this.options = {
      denseWeight: options?.denseWeight ?? 0.7,
      sparseWeight: options?.sparseWeight ?? 0.3,
      topK: options?.topK ?? 20,
      returnK: options?.returnK ?? 5,
      language: options?.language ?? 'english',
    };
  }

  /**
   * Converts an embedding array to a pgvector literal representation.
   *
   * @param {number[]} vec Vector to serialize.
   */
  private vectorLiteral(vec: number[]): string {
    return `[${vec.map((v) => Number(v).toFixed(6)).join(',')}]`;
  }

  /**
   * Expands a user query using an optional expander function and de-dupes
   * the result set.
   *
   * @param {string} query User query.
   */
  private async expandQueries(query: string): Promise<string[]> {
    if (!this.expander) return [query];
    const expanded = await this.expander(query);
    const all = [query, ...(expanded || [])].map((q) => q.trim()).filter(Boolean);
    return Array.from(new Set(all));
  }

  /**
   * Executes hybrid search over `rag_chunks`, merges sparse + dense results,
   * and returns the top ranked rows.
   *
   * @param {string} query User query.
   */
  public async search(query: string): Promise<RagSearchResult[]> {
    const { denseWeight, sparseWeight, topK, returnK, language } = this.options;
    const queries = await this.expandQueries(query);

    const merged: Map<number, RagSearchResult> = new Map();

    for (const q of queries) {
      // Sparse search (tsvector)
      const sparseRows = await this.prisma.$queryRawUnsafe(
        `SELECT id, parent_id, source_path, content,
                ts_rank_cd(content_tsv, plainto_tsquery($1::regconfig, $2)) AS sparse_score
         FROM rag_chunks
         WHERE content_tsv @@ plainto_tsquery($1::regconfig, $2)
         ORDER BY sparse_score DESC
         LIMIT $3`,
        language,
        q,
        topK
      );

      // Dense search (pgvector) if embedder is provided
      let denseRows: RagSearchResult[] = [];
      if (this.embedder) {
        const emb = await this.embedder(q);
        const vec = this.vectorLiteral(emb);
        denseRows = await this.prisma.$queryRawUnsafe(
          `SELECT id, parent_id, source_path, content,
                  1 - (vector <=> $1::vector) AS dense_score
           FROM rag_chunks
           ORDER BY vector <=> $1::vector
           LIMIT $2`,
          vec,
          topK
        );
      }

      const addRow = (row: RagSearchResult, kind: 'dense' | 'sparse') => {
        const existing = merged.get(row.id) ?? {
          id: row.id,
          parent_id: row.parent_id,
          source_path: row.source_path,
          content: row.content,
          score: 0,
          dense_score: 0,
          sparse_score: 0,
        };

        if (kind === 'dense') {
          existing.dense_score = Math.max(existing.dense_score || 0, row.dense_score || 0);
        } else {
          existing.sparse_score = Math.max(existing.sparse_score || 0, row.sparse_score || 0);
        }

        existing.score = (denseWeight! * (existing.dense_score || 0)) + (sparseWeight! * (existing.sparse_score || 0));
        merged.set(row.id, existing);
      };

      for (const row of sparseRows) addRow(row, 'sparse');
      for (const row of denseRows) addRow(row, 'dense');
    }

    const results = Array.from(merged.values()).sort((a, b) => b.score - a.score);
    return results.slice(0, returnK!);
  }
}
