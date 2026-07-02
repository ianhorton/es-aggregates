import { decrypt, encrypt, isEncrypted } from "../../src/aggregate/encryption";

const key = "key";
const value = "hello world";

describe("Encryption Tests (v2 envelope)", () => {
  it("produces a self-describing ENC1 / aes-256-gcm envelope", () => {
    const encrypted = encrypt(value, key);

    expect(encrypted).not.toEqual(value);
    expect(isEncrypted(encrypted)).toBe(true);

    const parts = encrypted.split(".");
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe("ENC1");
    expect(parts[1]).toBe("aes-256-gcm");
    expect(parts[2].length).toBeGreaterThan(0); // keyId
  });

  it("is non-deterministic (random IV per value) — not a hash", () => {
    const a = encrypt(value, key);
    const b = encrypt(value, key);
    expect(a).not.toEqual(b);
    // ...but both decrypt back to the same plaintext.
    expect(decrypt(a, key)).toEqual(value);
    expect(decrypt(b, key)).toEqual(value);
  });

  it("round-trips (decrypt(encrypt(x)) === x)", () => {
    const encrypted = encrypt(value, key);
    expect(decrypt(encrypted, key)).toEqual(value);
  });

  it("stamps the same keyId for the same key", () => {
    const kidA = encrypt(value, key).split(".")[2];
    const kidB = encrypt("other", key).split(".")[2];
    expect(kidA).toEqual(kidB);
  });

  it("stamps different keyIds for different keys", () => {
    const kid1 = encrypt(value, "key-one").split(".")[2];
    const kid2 = encrypt(value, "key-two").split(".")[2];
    expect(kid1).not.toEqual(kid2);
  });

  it("fails to decrypt with the wrong key (GCM tag)", () => {
    const encrypted = encrypt(value, key);
    expect(() => decrypt(encrypted, "wrong-key")).toThrow();
  });

  it("fails to decrypt a tampered ciphertext (integrity)", () => {
    const parts = encrypt(value, key).split(".");
    const tamperedCt = parts[4] === "AAAA" ? "BBBB" : "AAAA";
    const tampered = [parts[0], parts[1], parts[2], parts[3], tamperedCt, parts[5]].join(".");
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it("fails to decrypt a tampered tag (integrity)", () => {
    const parts = encrypt(value, key).split(".");
    const tamperedTag = parts[5].slice(0, -2) + (parts[5].endsWith("AA") ? "BB" : "AA");
    const tampered = [parts[0], parts[1], parts[2], parts[3], parts[4], tamperedTag].join(".");
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it("rejects a non-envelope value", () => {
    expect(() => decrypt("just plaintext", key)).toThrow(
      "Not a recognised encryption envelope"
    );
  });

  describe("isEncrypted", () => {
    it("is false for plaintext, empty, null, undefined, non-strings", () => {
      expect(isEncrypted("hello world")).toBe(false);
      expect(isEncrypted("")).toBe(false);
      expect(isEncrypted(null)).toBe(false);
      expect(isEncrypted(undefined)).toBe(false);
      expect(isEncrypted(42)).toBe(false);
    });

    it("is true for an envelope", () => {
      expect(isEncrypted(encrypt(value, key))).toBe(true);
    });
  });
});
