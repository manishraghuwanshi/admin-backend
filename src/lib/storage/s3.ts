import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { env } from "../../config/env.js";
import { AppError } from "../../utils/errors.js";

let client: S3Client | undefined;

export function isStorageConfigured(): boolean {
  return Boolean(env.AWS_ENDPOINT_URL_S3 && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
}

/**
 * The shared S3 client, created on first use.
 *
 * Exported so the readiness probe reuses the configured client instead of building a
 * second one: a second client could report storage healthy while the client the
 * application actually writes through is broken. Throws when storage is not
 * configured, which is why callers must check `isStorageConfigured()` first.
 */
export function getS3Client(): S3Client {
  if (!isStorageConfigured()) {
    throw new AppError("Object storage is not configured", 503, {
      code: "STORAGE_NOT_CONFIGURED",
    });
  }

  if (!client) {
    client = new S3Client({
      region: env.AWS_REGION,
      endpoint: env.AWS_ENDPOINT_URL_S3,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID as string,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY as string,
      },
      forcePathStyle: true,
    });
  }

  return client;
}

export async function putObject(input: {
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<void> {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: env.STORAGE_BUCKET,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
    }),
  );
}

export async function deleteObject(key: string): Promise<void> {
  await getS3Client().send(
    new DeleteObjectCommand({
      Bucket: env.STORAGE_BUCKET,
      Key: key,
    }),
  );
}

export async function getSignedDownloadUrl(key: string): Promise<string> {
  return getSignedUrl(
    getS3Client(),
    new GetObjectCommand({
      Bucket: env.STORAGE_BUCKET,
      Key: key,
    }),
    { expiresIn: env.SIGNED_URL_TTL_SECONDS },
  );
}

export const ALLOWED_IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
} as const;

export type AllowedMimeType = keyof typeof ALLOWED_IMAGE_TYPES;

export function detectImageMime(buffer: Buffer): AllowedMimeType | undefined {
  if (buffer.length < 12) {
    return undefined;
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }

  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  const header = buffer.toString("ascii", 0, 6);

  if (header === "GIF87a" || header === "GIF89a") {
    return "image/gif";
  }

  return undefined;
}
