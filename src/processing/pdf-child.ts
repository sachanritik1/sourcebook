import { PDFParse } from "pdf-parse";

const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 2_000_000;

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > MAX_PDF_BYTES) throw new Error("PDF exceeds input limit");
    chunks.push(data);
  }
  const parser = new PDFParse({
    data: new Uint8Array(Buffer.concat(chunks, size)),
  });
  try {
    const text = (await parser.getText()).text;
    if (text.length > MAX_EXTRACTED_CHARACTERS)
      throw new Error("Extracted text exceeds limit");
    process.stdout.write(text);
  } finally {
    await parser.destroy();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown PDF error";
  process.stderr.write(message.slice(0, 500));
  process.exitCode = 1;
});
