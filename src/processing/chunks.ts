const CHUNK_SIZE = 1000;
const OVERLAP = 150;

export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += CHUNK_SIZE - OVERLAP) {
    const chunk = text.slice(start, start + CHUNK_SIZE).trim();
    if (chunk) chunks.push(chunk);
    if (start + CHUNK_SIZE >= text.length) break;
  }
  return chunks;
}
