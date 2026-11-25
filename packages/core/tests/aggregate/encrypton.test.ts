import { TestAggregateRoot } from "@es-aggregates/store-tests";

import { Repository } from "../../src";
import { decrypt, encrypt, isEncrypted } from "../../src/aggregate/encryption";

import { InMemoryEventStore } from "../test-objects/in-memory-event-store";

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

  it("round-trips the EMPTY string (empty ciphertext segment)", () => {
    // AES-GCM of a zero-byte plaintext yields zero ciphertext bytes, so the
    // envelope has an empty parts[4]. isEncrypted must still recognise it and
    // decrypt must round-trip to "" — not leak the raw envelope string.
    const encrypted = encrypt("", key);
    expect(isEncrypted(encrypted)).toBe(true);
    expect(encrypted.split(".")).toHaveLength(6);
    expect(encrypted.split(".")[4]).toBe(""); // empty ciphertext segment
    expect(decrypt(encrypted, key)).toBe("");
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

  describe("length of the tag", () => {
    // the envelope with its tag cut to that many bytes, or filled up to them with zeros
    const withTagOf = (length: number, envelope: string): string => {
      const parts = envelope.split(".");
      const tag = Buffer.alloc(length);
      Buffer.from(parts[5], "base64url").copy(tag);
      return [...parts.slice(0, 5), tag.toString("base64url")].join(".");
    };

    describe.each([
      ["a value", value],
      ["the EMPTY string", ""],
    ])("of %s", (_, plaintext) => {
      it("decrypts with the full tag, which has 16 bytes", () => {
        const encrypted = encrypt(plaintext, key);

        expect(withTagOf(16, encrypted)).toBe(encrypted);
        expect(decrypt(encrypted, key)).toBe(plaintext);
      });

      it.each([4, 8, 12, 15, 17, 32])(
        "fails to decrypt with a tag of %i bytes",
        (length) => {
          const altered = withTagOf(length, encrypt(plaintext, key));

          expect(() => decrypt(altered, key)).toThrow(
            `Invalid authentication tag length: ${length}`
          );
        }
      );
    });

    describe("through Repository", () => {
      afterEach(() => {
        jest.restoreAllMocks();
      });

      it.each([4, 8, 12, 15])(
        "leaves a value with a tag of %i bytes as it is, and logs it",
        async (length) => {
          // arrange
          const store = new InMemoryEventStore();
          const repo = new Repository(store, TestAggregateRoot.factory);
          const ar = TestAggregateRoot.create("aggregate id", "name");
          ar.createMessage("text", "https://example.com/image.png");
          await repo.writeAsync(ar, key);

          const [created, message] = await store.readAsync(ar.id);
          const shortened = withTagOf(length, message.data.text);
          message.data.text = shortened;
          jest.spyOn(store, "readAsync").mockResolvedValue([created, message]);
          const log = jest.spyOn(console, "error").mockImplementation(() => {});

          // act
          const readAr = (await repo.readAsync(ar.id, key))!;

          // assert: the other values are decrypted as usual
          expect(readAr.state).toEqual({ ...ar.state, messageText: shortened });
          expect(log.mock.calls).toEqual([
            [expect.stringContaining('Failed to decrypt PII field "text"')],
          ]);
          expect(log.mock.calls[0][0]).toContain(
            `Invalid authentication tag length: ${length}.`
          );
        }
      );
    });
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
