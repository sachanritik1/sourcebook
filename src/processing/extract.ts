import { spawn } from "node:child_process";
import { join } from "node:path";

const MAX_EXTRACTED_CHARACTERS = 2_000_000;
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_PDF_OUTPUT_BYTES = MAX_EXTRACTED_CHARACTERS * 4;

function pdfTimeoutMs(): number {
  const value = Number(process.env.PDF_EXTRACTION_TIMEOUT_MS ?? 30_000);
  if (!Number.isInteger(value) || value < 1 || value > 120_000)
    throw new Error("PDF_EXTRACTION_TIMEOUT_MS must be 1 to 120000");
  return value;
}

async function extractPdf(content: Buffer): Promise<string> {
  if (content.length > MAX_PDF_BYTES)
    throw new Error("PDF exceeds input limit");
  const timeoutMs = pdfTimeoutMs();
  const script = join(
    __dirname,
    __filename.endsWith(".ts")
      ? "../../dist/processing/pdf-child.js"
      : "pdf-child.js",
  );
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=128", script],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { NODE_ENV: "production" },
      },
    );
    const output: Buffer[] = [];
    let outputBytes = 0;
    let errorMessage = "";
    let settled = false;
    const finish = (error?: Error, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(text ?? "");
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("PDF extraction timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PDF_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("Extracted text exceeds limit"));
        return;
      }
      output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorMessage = (errorMessage + chunk.toString("utf8")).slice(0, 500);
    });
    child.stdin.on("error", () => {
      // The child may exit before consuming all input; close reports its failure.
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(errorMessage || "PDF extraction process failed"));
        return;
      }
      try {
        finish(
          undefined,
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(output, outputBytes),
          ),
        );
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Invalid PDF text"));
      }
    });
    child.stdin.end(content);
  });
}

export async function extractText(
  content: Buffer,
  mediaType: string,
): Promise<string> {
  let text: string;
  if (mediaType === "text/plain") {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } else if (mediaType === "application/pdf") {
    text = await extractPdf(content);
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
