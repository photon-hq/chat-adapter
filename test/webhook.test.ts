import { describe, expect, it } from "vitest";
import { decodeWebhookSecret, verifyWebhookSignature } from "../src/webhook";

// Synthetic interoperability vector from @photon-hq/contracts
// (schemas/test-vectors/standard-webhooks.json); not a credential.
const vector = {
  body: '{"synthetic":true,"text":"Hello 🌍"}',
  id: "synthetic-vector",
  signature: "v1,0urZDpPAiQuH0H0rEB2NpIzgZKIhN6z++ZQqVUiN8e8=",
  timestamp: "1767225600",
  now: Date.parse("2026-01-01T00:00:00.000Z"),
  secret: "whsec_BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
};
const key = decodeWebhookSecret(vector.secret) as Buffer;
const encode = (text: string) => new TextEncoder().encode(text);
const headers = (overrides: Record<string, string> = {}) =>
  new Headers({
    "webhook-id": vector.id,
    "webhook-timestamp": vector.timestamp,
    "webhook-signature": vector.signature,
    ...overrides,
  });

describe("verifyWebhookSignature", () => {
  it("accepts the contracts test vector", () => {
    expect(
      verifyWebhookSignature(encode(vector.body), headers(), key, vector.now)
    ).toBe(vector.id);
  });

  it("accepts a valid signature beside a retiring one", () => {
    const rotated = headers({
      "webhook-signature": `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${vector.signature}`,
    });
    expect(
      verifyWebhookSignature(encode(vector.body), rotated, key, vector.now)
    ).toBe(vector.id);
  });

  it("rejects a changed body", () => {
    expect(
      verifyWebhookSignature(
        encode(vector.body.replace("Hello", "Hallo")),
        headers(),
        key,
        vector.now
      )
    ).toBeUndefined();
  });

  it("rejects a timestamp outside five minutes", () => {
    expect(
      verifyWebhookSignature(
        encode(vector.body),
        headers(),
        key,
        vector.now + 301_000
      )
    ).toBeUndefined();
  });

  it("rejects missing headers", () => {
    const missing = headers();
    missing.delete("webhook-signature");
    expect(
      verifyWebhookSignature(encode(vector.body), missing, key, vector.now)
    ).toBeUndefined();
  });
});
