import { describe, expect, it } from "vitest";
import { readUpload, UploadError } from "../lib/upload";

function uploadRequest(entries: Array<[string, File | string]>): Request {
  const body = new FormData();
  for (const [name, value] of entries) body.append(name, value);
  return new Request("http://localhost:3001/api/workspaces/123/documents", {
    method: "POST",
    body,
  });
}

describe("browser upload boundary", () => {
  it("accepts one small source file", async () => {
    const file = new File(["A source note"], "notes.txt", {
      type: "text/plain",
    });
    const accepted = await readUpload(uploadRequest([["file", file]]));
    expect(accepted.name).toBe("notes.txt");
    expect(await accepted.text()).toBe("A source note");
  });

  it("rejects files larger than the API limit before forwarding", async () => {
    const file = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.txt", {
      type: "text/plain",
    });
    await expect(
      readUpload(uploadRequest([["file", file]])),
    ).rejects.toMatchObject({
      status: 413,
      code: "file_too_large",
    } satisfies Partial<UploadError>);
  });

  it("rejects a second form field", async () => {
    const file = new File(["note"], "notes.txt", { type: "text/plain" });
    await expect(
      readUpload(
        uploadRequest([
          ["file", file],
          ["unexpected", "value"],
        ]),
      ),
    ).rejects.toMatchObject({ status: 400, code: "invalid_upload" });
  });
});
