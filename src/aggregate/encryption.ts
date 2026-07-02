import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * PII encryption v2 — self-describing envelope (qp-9k9o).
 *
 * Every encrypted value is a self-describing string:
 *
 *   ENC1.<alg>.<keyId>.<iv>.<ciphertext>.<tag>
 *
 * - ENC1  sentinel + envelope-format version (lets the format evolve).
 * - alg   the cipher (aes-256-gcm — authenticated; CBC had no integrity).
 * - keyId which key encrypted this value. The rotation linchpin: recorded now
 *         (impossible to retrofit later), for a keyed store when key versioning
 *         is actually built. Today there is one per-user key, so the read path
 *         decrypts with the single provided key and keyId is informational; the
 *         GCM tag is what proves the key is correct.
 * - iv    per-value random 12-byte GCM nonce (base64url).
 * - ciphertext, tag  base64url; tag is the 16-byte GCM auth tag.
 *
 * The read path decides decrypt-vs-passthrough from the VALUE ITSELF
 * (`isEncrypted`), never from an external marker. Plaintext (written key-less)
 * carries no sentinel and is therefore never fed to decrypt — a decrypt of
 * plaintext ("landmine") is impossible.
 */

const ENVELOPE_VERSION = "ENC1";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM standard nonce length
const KEY_ID_LENGTH = 12;
const DELIMITER = ".";
const ENVELOPE_PARTS = 6;

/** Derive the 32-byte AES key from the caller's key material. */
const prepareKey = (key: string): Buffer =>
  createHash("sha256").update(String(key)).digest();

/**
 * Stable short identifier for a key. One-way (reveals nothing usable about the
 * key) and distinct per key value — so it naturally distinguishes key versions
 * once rotation exists.
 */
const keyId = (key: string): string =>
  createHash("sha256")
    .update(`kid:${String(key)}`)
    .digest("base64url")
    .slice(0, KEY_ID_LENGTH);

const b64url = (b: Buffer): string => b.toString("base64url");
const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");

/**
 * True iff `value` is an encryption envelope (carries the sentinel prefix).
 * base64url never contains the "." delimiter, so a plaintext value can only be
 * mistaken for an envelope if it literally begins with "ENC1." — and even then
 * the GCM tag rejects it on decrypt.
 */
function isEncrypted(value: unknown): value is string {
  return (
    typeof value === "string" && value.startsWith(ENVELOPE_VERSION + DELIMITER)
  );
}

function encrypt(data: string, key: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, prepareKey(key), iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(data), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    ENVELOPE_VERSION,
    ALGORITHM,
    keyId(key),
    b64url(iv),
    b64url(ciphertext),
    b64url(tag),
  ].join(DELIMITER);
}

function decrypt(value: string, key: string): string {
  const parts = value.split(DELIMITER);
  if (parts.length !== ENVELOPE_PARTS || parts[0] !== ENVELOPE_VERSION) {
    throw new Error("Not a recognised encryption envelope");
  }

  const [, alg, , ivPart, ciphertextPart, tagPart] = parts;
  if (alg !== ALGORITHM) {
    throw new Error(`Unsupported envelope algorithm: ${alg}`);
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    prepareKey(key),
    fromB64url(ivPart)
  );
  decipher.setAuthTag(fromB64url(tagPart));

  // decipher.final() throws if the tag does not verify (tampered value or wrong
  // key) — integrity is enforced, not just confidentiality.
  return Buffer.concat([
    decipher.update(fromB64url(ciphertextPart)),
    decipher.final(),
  ]).toString("utf8");
}

export { encrypt, decrypt, isEncrypted };
