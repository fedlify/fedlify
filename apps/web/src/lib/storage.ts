import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let bucketReady = false;

function storageBucket(): string {
  return process.env.S3_BUCKET ?? "";
}

function s3Client(): S3Client {
  return new S3Client({
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: process.env.S3_REGION ?? "us-east-1",
    credentials:
      process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
          }
        : undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true"
  });
}

export function storageConfigured(): boolean {
  return Boolean(storageBucket());
}

export function objectKey(parts: string[]): string {
  return parts.map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}

export async function createPresignedUploadUrl(key: string, contentType: string): Promise<string> {
  const bucket = storageBucket();
  if (!bucket) throw new Error("S3_BUCKET is not configured.");
  await ensureBucket();
  return getSignedUrl(
    s3Client(),
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType
    }),
    { expiresIn: 60 * 10 }
  );
}

export async function uploadObject(key: string, body: string | Buffer, contentType: string): Promise<void> {
  const bucket = storageBucket();
  if (!bucket) throw new Error("S3_BUCKET is not configured.");
  await ensureBucket();
  await s3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType
    })
  );
}

export async function readObject(key: string): Promise<Buffer> {
  const bucket = storageBucket();
  if (!bucket) throw new Error("S3_BUCKET is not configured.");
  await ensureBucket();
  const response = await s3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) throw new Error("Stored artifact has no body.");
  return Buffer.from(await response.Body.transformToByteArray());
}

export async function deleteObject(key: string): Promise<void> {
  const bucket = storageBucket();
  if (!bucket) throw new Error("S3_BUCKET is not configured.");
  await s3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function createPresignedDownloadUrl(key: string, filename: string): Promise<string> {
  const bucket = storageBucket();
  if (!bucket) throw new Error("S3_BUCKET is not configured.");
  await ensureBucket();
  return getSignedUrl(
    s3Client(),
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${filename.replaceAll('"', "")}"`
    }),
    { expiresIn: 60 * 5 }
  );
}

async function ensureBucket(): Promise<void> {
  const bucket = storageBucket();
  if (!bucket || bucketReady) return;
  const client = s3Client();
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const name = (error as { name?: string }).name;
    if (status !== 404 && name !== "NotFound" && name !== "NoSuchBucket") {
      throw error;
    }
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  bucketReady = true;
}
