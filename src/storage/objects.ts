import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const MAX_OBJECT_BYTES = 5 * 1024 * 1024;

export interface ObjectStore {
  put(key: string, content: Buffer, mediaType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export function stagedObjectKey(workspaceId: string, key: string): string {
  return `documents/${workspaceId}/${key}`;
}

export function s3Configuration(): { client: S3Client; bucket: string } {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error("S3_BUCKET is required in S3 storage mode");
  const endpoint = process.env.S3_ENDPOINT;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey))
    throw new Error("S3 access and secret keys must be configured together");
  return {
    bucket,
    client: new S3Client({
      region: process.env.S3_REGION ?? "us-east-1",
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
      maxAttempts: 2,
    }),
  };
}

export function configuredObjectStore(): ObjectStore | undefined {
  const mode = process.env.DOCUMENT_STORAGE ?? "postgres";
  if (mode === "postgres") return undefined;
  if (mode !== "s3") throw new Error("DOCUMENT_STORAGE must be postgres or s3");
  const { client, bucket } = s3Configuration();
  return new S3ObjectStore(client, bucket);
}

export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async put(key: string, content: Buffer, mediaType: string): Promise<void> {
    if (content.length > MAX_OBJECT_BYTES)
      throw new Error("Object exceeds upload limit");
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: content,
        ContentType: mediaType,
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
  }

  async get(key: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
    if (!result.Body) throw new Error("Stored object has no body");
    if (result.ContentLength && result.ContentLength > MAX_OBJECT_BYTES)
      throw new Error("Stored object exceeds upload limit");
    const content = Buffer.from(await result.Body.transformToByteArray());
    if (content.length > MAX_OBJECT_BYTES)
      throw new Error("Stored object exceeds upload limit");
    return content;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
  }
}
