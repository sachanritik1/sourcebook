export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_FILE_BYTES + 64 * 1024;

export class UploadError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

export async function readUpload(request: Request): Promise<File> {
  const contentType = request.headers.get("content-type");
  if (
    !contentType ||
    !/^multipart\/form-data\s*;\s*boundary=/i.test(contentType)
  ) {
    throw new UploadError(400, "invalid_upload");
  }
  if (Number(request.headers.get("content-length")) > MAX_MULTIPART_BYTES) {
    throw new UploadError(413, "file_too_large");
  }
  if (!request.body) throw new UploadError(400, "file_required");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MULTIPART_BYTES) {
        await reader.cancel();
        throw new UploadError(413, "file_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let form: FormData;
  try {
    const bounded = new Request(request.url, {
      method: "POST",
      headers: { "content-type": contentType },
      body: new Blob([bytes]),
    });
    form = await bounded.formData();
  } catch {
    throw new UploadError(400, "invalid_upload");
  }
  const entries = [...form.entries()];
  if (entries.length !== 1 || entries[0]?.[0] !== "file") {
    throw new UploadError(400, "invalid_upload");
  }
  const file = entries[0][1];
  if (!(file instanceof File) || file.size === 0) {
    throw new UploadError(400, "file_required");
  }
  if (file.size > MAX_FILE_BYTES) throw new UploadError(413, "file_too_large");
  return file;
}
