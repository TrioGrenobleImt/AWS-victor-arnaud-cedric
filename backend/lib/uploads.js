// S3 presigned URLs for the back office (admin API only: the presigners are
// not part of the Lambda runtime SDK).
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { env, s3 } from "./aws.js";
import { ValidationError } from "./orders.js";

export const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }; // no SVG: it can carry scripts
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Lets the browser upload a product image straight to the images bucket.
 * A presigned POST (unlike PUT) enforces the size and type server side.
 */
export async function presignImageUpload(contentType) {
  const ext = IMAGE_TYPES[contentType];
  if (!ext) throw new ValidationError(`content_type must be one of ${Object.keys(IMAGE_TYPES).join(", ")}`);
  const key = `images/uploads/${randomUUID()}.${ext}`;
  const { url, fields } = await createPresignedPost(s3, {
    Bucket: env("IMAGES_BUCKET"),
    Key: key,
    Conditions: [
      ["content-length-range", 1, MAX_IMAGE_BYTES],
      ["eq", "$Content-Type", contentType],
    ],
    Fields: { "Content-Type": contentType, "Cache-Control": "public, max-age=31536000, immutable" },
    Expires: 300,
  });
  return { url, fields, key };
}

/** Short-lived link to an internal document (e.g. a packing slip). */
export function presignDocument(key) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: env("DOCUMENTS_BUCKET"), Key: key }), { expiresIn: 300 });
}
