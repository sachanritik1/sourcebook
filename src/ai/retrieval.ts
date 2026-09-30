import type { Pool } from "pg";

export type RetrievedChunk = {
  chunkId: string;
  documentId: string;
  filename: string;
  ordinal: number;
  content: string;
  score: number;
};

export async function retrieveChunks(
  pool: Pool,
  workspaceId: string,
  userId: string,
  model: string,
  vector: string,
  topK: number,
): Promise<RetrievedChunk[]> {
  const result = await pool.query<RetrievedChunk>(
    `SELECT c.id AS "chunkId", c.document_id AS "documentId", d.filename,
            c.ordinal, c.content, 1 - (e.embedding <=> $3::vector) AS score
     FROM document_embeddings e
     JOIN document_chunks c ON c.workspace_id = e.workspace_id AND c.id = e.chunk_id
     JOIN documents d ON d.workspace_id = c.workspace_id AND d.id = c.document_id
     WHERE e.workspace_id = $1 AND e.model = $4 AND d.status = 'completed'
       AND (d.expires_at IS NULL OR d.expires_at > now())
       AND EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.workspace_id = e.workspace_id AND m.user_id = $2)
     ORDER BY e.embedding <=> $3::vector, c.id
     LIMIT $5`,
    [workspaceId, userId, vector, model, topK],
  );
  return result.rows;
}
