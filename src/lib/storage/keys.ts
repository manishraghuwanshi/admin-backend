import { randomUUID } from "node:crypto";

import { AppError } from "../../utils/errors.js";
import { detectImageMime, type AllowedMimeType } from "./s3.js";

/**
 * Server-controlled object keys for product images.
 *
 * The client never supplies a key. Keys are built here from a fixed prefix, the
 * product id this image belongs to, a fresh UUID, and an extension derived from
 * the sniffed content type - never from user text. That makes three things
 * structurally impossible: path traversal (`..`, leading `/`, embedded slashes),
 * key collisions between two uploads of the same file, and a key whose extension
 * disagrees with the bytes stored under it.
 */

const IMAGE_KEY_PREFIX = "products";

/** Base64 payloads are capped relative to the decoded byte limit. */
const BASE64_OVERHEAD_NUMERATOR = 4;
const BASE64_OVERHEAD_DENOMINATOR = 3;

export interface DecodedImage {
  buffer: Buffer;
  mimeType: AllowedMimeType;
  /** Byte length after decoding, which is what the size limit applies to. */
  byteLength: number;
}

/**
 * Decode and validate a base64 image body.
 *
 * Accepts both raw base64 and a data URL. `Buffer.from(_, "base64")` is forgiving
 * - it drops invalid characters rather than failing - so size and content type are
 * both re-checked afterwards instead of trusted from the input.
 */
export function decodeImagePayload(
  input: string,
  options: { maxBytes: number },
): DecodedImage {
  if (typeof input !== "string" || input.length === 0) {
    throw new AppError("data must be a non-empty base64 string", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  const dataUrlMatch = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(input);
  const declaredType = dataUrlMatch?.[1]?.toLowerCase();
  const payload = dataUrlMatch ? dataUrlMatch[3] : input;

  if (dataUrlMatch && !dataUrlMatch[2]) {
    throw new AppError("data URL must use base64 encoding", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  // Reject absurdly long strings before paying for the decode.
  const encodedCeiling = Math.ceil(
    (options.maxBytes * BASE64_OVERHEAD_NUMERATOR) / BASE64_OVERHEAD_DENOMINATOR,
  );

  if (payload.length > encodedCeiling) {
    throw tooLarge(options.maxBytes);
  }

  const buffer = Buffer.from(payload, "base64");

  if (buffer.length === 0) {
    throw new AppError("data could not be decoded as base64", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  if (buffer.length > options.maxBytes) {
    throw tooLarge(options.maxBytes);
  }

  const mimeType = detectImageMime(buffer);

  if (!mimeType) {
    throw new AppError("Content is not a supported image type", 415, {
      code: "UNPROCESSABLE_ENTITY",
    });
  }

  // A data URL that names a different type than the bytes carry is rejected rather
  // than silently trusted, because that mismatch is how a disguised upload arrives.
  if (declaredType && declaredType !== mimeType) {
    throw new AppError("Declared content type does not match the image content", 415, {
      code: "UNPROCESSABLE_ENTITY",
    });
  }

  return { buffer, mimeType, byteLength: buffer.length };
}

function tooLarge(maxBytes: number): AppError {
  return new AppError(`Image exceeds the ${maxBytes} byte limit`, 413, {
    code: "PAYLOAD_TOO_LARGE",
  });
}

/** Extension for a sniffed type; mirrors `ALLOWED_IMAGE_TYPES` in `s3.ts`. */
function extensionFor(mimeType: AllowedMimeType): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
  }
}

/**
 * Build the storage key for a new image.
 *
 * `productId` is interpolated only after UUID validation, so a malformed id can
 * never inject path separators into the key. The random UUID segment means two
 * concurrent uploads can never overwrite each other, and overwriting is what makes
 * a delete of one image destroy another.
 */
export function buildProductImageKey(productId: string, mimeType: AllowedMimeType): string {
  if (!isUuid(productId)) {
    throw new AppError("Cannot build a storage key for an invalid product id", 500, {
      code: "INTERNAL_ERROR",
    });
  }

  return `${IMAGE_KEY_PREFIX}/${productId}/${randomUUID()}.${extensionFor(mimeType)}`;
}

/**
 * True for a key this module could plausibly have produced.
 *
 * Used defensively before any delete: since the key comes out of the database, a
 * tampered or hand-edited row must not be able to aim `DeleteObjectCommand` at an
 * arbitrary object in the shared bucket.
 */
export function isProductImageKey(key: string): boolean {
  return new RegExp(`^${IMAGE_KEY_PREFIX}/${UUID_PATTERN}/[0-9a-f-]{36}\\.(jpg|png|webp|gif)$`).test(
    key,
  );
}

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function isUuid(value: string): boolean {
  return new RegExp(`^${UUID_PATTERN}$`, "i").test(value);
}
