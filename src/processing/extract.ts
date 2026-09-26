import { PDFParse } from "pdf-parse";

const MAX_EXTRACTED_CHARACTERS = 2_000_000;

export async function extractText(
  content: Buffer,
  mediaType: string,
): Promise<string> {
  let text: string;
  if (mediaType === "text/plain") {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } else if (mediaType === "application/pdf") {
    const parser = new PDFParse({ data: new Uint8Array(content) });
    try {
      text = (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  } else {
    throw new Error("Unsupported media type");
  }
  text = text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!text) throw new Error("No extractable text found");
  if (text.length > MAX_EXTRACTED_CHARACTERS)
    throw new Error("Extracted text exceeds limit");
  return text;
}
