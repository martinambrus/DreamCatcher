export class RagSearch {
    constructor({ prisma, embedder, expander, options }) {
        var _a, _b, _c, _d, _e;
        this.prisma = prisma;
        this.embedder = embedder;
        this.expander = expander;
        this.options = {
            denseWeight: (_a = options === null || options === void 0 ? void 0 : options.denseWeight) !== null && _a !== void 0 ? _a : 0.7,
            sparseWeight: (_b = options === null || options === void 0 ? void 0 : options.sparseWeight) !== null && _b !== void 0 ? _b : 0.3,
            topK: (_c = options === null || options === void 0 ? void 0 : options.topK) !== null && _c !== void 0 ? _c : 20,
            returnK: (_d = options === null || options === void 0 ? void 0 : options.returnK) !== null && _d !== void 0 ? _d : 5,
            language: (_e = options === null || options === void 0 ? void 0 : options.language) !== null && _e !== void 0 ? _e : 'english',
        };
    }
    vectorLiteral(vec) {
        return `[${vec.map((v) => Number(v).toFixed(6)).join(',')}]`;
    }
    async expandQueries(query) {
        if (!this.expander)
            return [query];
        const expanded = await this.expander(query);
        const all = [query, ...(expanded || [])].map((q) => q.trim()).filter(Boolean);
        return Array.from(new Set(all));
    }
    async search(query) {
        const { denseWeight, sparseWeight, topK, returnK, language } = this.options;
        const queries = await this.expandQueries(query);
        const merged = new Map();
        for (const q of queries) {
            // Sparse search (tsvector)
            const sparseRows = await this.prisma.$queryRawUnsafe(`SELECT id, parent_id, source_path, content,
                ts_rank_cd(content_tsv, plainto_tsquery($1::regconfig, $2)) AS sparse_score
         FROM rag_chunks
         WHERE content_tsv @@ plainto_tsquery($1::regconfig, $2)
         ORDER BY sparse_score DESC
         LIMIT $3`, language, q, topK);
            // Dense search (pgvector) if embedder is provided
            let denseRows = [];
            if (this.embedder) {
                const emb = await this.embedder(q);
                const vec = this.vectorLiteral(emb);
                denseRows = await this.prisma.$queryRawUnsafe(`SELECT id, parent_id, source_path, content,
                  1 - (vector <=> $1::vector) AS dense_score
           FROM rag_chunks
           ORDER BY vector <=> $1::vector
           LIMIT $2`, vec, topK);
            }
            const addRow = (row, kind) => {
                var _a;
                const existing = (_a = merged.get(row.id)) !== null && _a !== void 0 ? _a : {
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
                }
                else {
                    existing.sparse_score = Math.max(existing.sparse_score || 0, row.sparse_score || 0);
                }
                existing.score = (denseWeight * (existing.dense_score || 0)) + (sparseWeight * (existing.sparse_score || 0));
                merged.set(row.id, existing);
            };
            for (const row of sparseRows)
                addRow(row, 'sparse');
            for (const row of denseRows)
                addRow(row, 'dense');
        }
        const results = Array.from(merged.values()).sort((a, b) => b.score - a.score);
        return results.slice(0, returnK);
    }
}
