import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 300;
const SECRET_PREFIX = /^whsec_/u;
const DIGITS = /^\d+$/u;
const WHITESPACE = /\s+/u;

/** Decodes a `whsec_<base64>` signing secret into its HMAC key bytes. */
export function decodeWebhookSecret(secret: string): Buffer | undefined {
  const key = Buffer.from(secret.trim().replace(SECRET_PREFIX, ""), "base64");
  return key.length > 0 ? key : undefined;
}

/**
 * Verifies a Standard Webhooks signature over the exact request bytes. Returns
 * the signed `webhook-id` when a `v1` signature matches and the timestamp is
 * within five minutes, otherwise `undefined`.
 */
export function verifyWebhookSignature(
  body: Uint8Array,
  headers: Headers,
  key: Buffer,
  nowMs = Date.now()
): string | undefined {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!(id && timestamp && signatures && DIGITS.test(timestamp))) {
    return;
  }
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) {
    return;
  }

  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest();
  const matches = signatures
    .trim()
    .split(WHITESPACE)
    .some((entry) => {
      const [version, value] = entry.split(",");
      if (version !== "v1" || !value) {
        return false;
      }
      const candidate = Buffer.from(value, "base64");
      return (
        candidate.length === expected.length &&
        timingSafeEqual(candidate, expected)
      );
    });
  return matches ? id : undefined;
}
