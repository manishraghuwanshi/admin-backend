import { describe, expect, it } from "vitest";

import {
  buildProductImageKey,
  decodeImagePayload,
  isProductImageKey,
} from "../lib/storage/keys.js";
import { detectImageMime } from "../lib/storage/s3.js";
import { AppError } from "../utils/errors.js";

/**
 * Object-key generation and image-payload decoding.
 *
 * Both are pure and both are load-bearing for security: the key rules are what make
 * path traversal and key collisions structurally impossible, and the decoder is what
 * stops a client from storing arbitrary bytes by lying about a filename or MIME type.
 *
 * The fixtures are synthetic buffers rather than real image files. The service never
 * decodes image content - it only sniffs the type and stores bytes - so a correct
 * header plus padding exercises every branch without embedding binary fixtures.
 */

const UUID_PRODUCT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** Magic bytes plus padding; `detectImageMime` needs at least 12 bytes. */
function fakeImage(kind: "jpeg" | "png" | "webp" | "gif", padding = 16): Buffer {
  const header =
    kind === "jpeg"
      ? Buffer.from([0xff, 0xd8, 0xff])
      : kind === "png"
        ? Buffer.from([0x89, 0x50, 0x4e, 0x47])
        : kind === "webp"
          ? Buffer.from("RIFF....WEBP", "ascii")
          : Buffer.from("GIF89a", "ascii");

  return Buffer.concat([header, Buffer.alloc(padding)]);
}

/** Runs `fn` and returns whatever it threw, so error fields can be asserted. */
function thrownFrom(fn: () => unknown): unknown {
  try {
    fn();

    return undefined;
  } catch (error) {
    return error;
  }
}

function shapeOf(error: unknown): { statusCode?: number; code?: string } {
  return error instanceof AppError
    ? { statusCode: error.statusCode, code: error.code }
    : {};
}

describe("storage keys: shape and validation", () => {
  it("builds a key under the products prefix from the product id and sniffed type", () => {
    for (const [mimeType, extension] of [
      ["image/jpeg", "jpg"],
      ["image/png", "png"],
      ["image/webp", "webp"],
      ["image/gif", "gif"],
    ] as const) {
      const key = buildProductImageKey(UUID_PRODUCT, mimeType);

      expect(key.startsWith(`products/${UUID_PRODUCT}/`)).toBe(true);
      expect(key.endsWith(`.${extension}`)).toBe(true);
      expect(isProductImageKey(key)).toBe(true);
    }
  });

  it("never reuses a key, so two uploads cannot overwrite each other", () => {
    const keys = new Set(
      Array.from({ length: 25 }, () => buildProductImageKey(UUID_PRODUCT, "image/png")),
    );

    expect(keys.size).toBe(25);
  });

  it("refuses to build a key from a non-UUID product id", () => {
    expect(thrownFrom(() => buildProductImageKey("../../etc/passwd", "image/png"))).toBeInstanceOf(
      AppError,
    );
    expect(thrownFrom(() => buildProductImageKey("products/x", "image/png"))).toBeInstanceOf(
      AppError,
    );
  });

  it("rejects keys that could not have come from this module", () => {
    const bad = [
      "",
      "products",
      // Traversal and cross-tenant shapes a prefix-only check would wave through.
      `products/${UUID_PRODUCT}/../../secret.jpg`,
      "products/other-bucket/file.png",
      `products/${UUID_PRODUCT}/${UUID_PRODUCT}.jpg/`,
      `products/${UUID_PRODUCT}/${UUID_PRODUCT}.exe`,
      // Upper-case hex is not what randomUUID() produces.
      `products/${UUID_PRODUCT}/${UUID_PRODUCT.toUpperCase()}.jpg`,
      `http://evil.example/${UUID_PRODUCT}.jpg`,
    ];

    for (const key of bad) {
      expect(isProductImageKey(key)).toBe(false);
    }
  });
});

describe("storage: magic-byte detection", () => {
  it("identifies each supported type", () => {
    expect(detectImageMime(fakeImage("jpeg"))).toBe("image/jpeg");
    expect(detectImageMime(fakeImage("png"))).toBe("image/png");
    expect(detectImageMime(fakeImage("webp"))).toBe("image/webp");
    expect(detectImageMime(fakeImage("gif"))).toBe("image/gif");
  });

  it("rejects non-images and anything too short to carry a header", () => {
    expect(detectImageMime(Buffer.from("%PDF-1.4 fake document!!"))).toBeUndefined();
    expect(detectImageMime(Buffer.from("<svg onload=alert(1)>"))).toBeUndefined();
    expect(detectImageMime(Buffer.from([0x89, 0x50, 0x4e]))).toBeUndefined();
    expect(detectImageMime(Buffer.alloc(0))).toBeUndefined();
  });
});

describe("storage: base64 payload decoding", () => {
  const maxBytes = 4096;
  const png = fakeImage("png", 200);

  it("accepts raw base64 and sniffs the type from the bytes", () => {
    const decoded = decodeImagePayload(png.toString("base64"), { maxBytes });

    expect(decoded.mimeType).toBe("image/png");
    expect(decoded.byteLength).toBe(png.length);
    expect(decoded.buffer.equals(png)).toBe(true);
  });

  it("accepts a data URL and strips the prefix", () => {
    const decoded = decodeImagePayload(`data:image/png;base64,${png.toString("base64")}`, {
      maxBytes,
    });

    expect(decoded.mimeType).toBe("image/png");
    expect(decoded.byteLength).toBe(png.length);
  });

  it("measures the limit against decoded bytes, not the base64 string", () => {
    const encoded = png.toString("base64");

    // Base64 inflates by a third: 272 characters decode to 204 bytes, which fit.
    expect(encoded.length).toBeGreaterThan(png.length);
    expect(decodeImagePayload(encoded, { maxBytes: png.length }).byteLength).toBe(png.length);

    const overLimit = thrownFrom(() =>
      decodeImagePayload(encoded, { maxBytes: png.length - 1 }),
    );

    expect(shapeOf(overLimit)).toEqual({ statusCode: 413, code: "PAYLOAD_TOO_LARGE" });
  });

  it("rejects a data URL whose declared type disagrees with the bytes", () => {
    const disguised = `data:image/png;base64,${fakeImage("jpeg").toString("base64")}`;
    const error = thrownFrom(() => decodeImagePayload(disguised, { maxBytes }));

    expect(shapeOf(error)).toEqual({ statusCode: 415, code: "UNPROCESSABLE_ENTITY" });
  });

  it("rejects a non-base64 data URL", () => {
    const error = thrownFrom(() => decodeImagePayload("data:image/png,%89PNG", { maxBytes }));

    expect(shapeOf(error)).toEqual({ statusCode: 400, code: "VALIDATION_ERROR" });
  });

  it("rejects content that is not a supported image", () => {
    const script = Buffer.from("#!/bin/sh\nrm -rf /\n".repeat(4)).toString("base64");
    const error = thrownFrom(() => decodeImagePayload(script, { maxBytes }));

    expect(shapeOf(error)).toEqual({ statusCode: 415, code: "UNPROCESSABLE_ENTITY" });
  });

  it("rejects an empty value and one that is not base64 at all", () => {
    expect(shapeOf(thrownFrom(() => decodeImagePayload("", { maxBytes })))).toEqual({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
    expect(shapeOf(thrownFrom(() => decodeImagePayload("!!!!", { maxBytes })))).toEqual({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
  });

  it("rejects an oversized string before paying for the decode", () => {
    // 6000 characters is far past the ~5462 ceiling for a 4096 byte limit.
    const error = thrownFrom(() => decodeImagePayload("A".repeat(6000), { maxBytes }));

    expect(shapeOf(error)).toEqual({ statusCode: 413, code: "PAYLOAD_TOO_LARGE" });
  });
});
