import { TestAggregateRoot } from "@es-aggregates/store-tests";

import { decrypt, Repository } from "../../src";

import { InMemoryEventStore } from "../test-objects/in-memory-event-store";

// Their messages get into logs, so they must have no part of a value in them, nor of a key.
describe("Errors of encryption", () => {
  const id = "aggregate id";
  const key = "0123456789";
  const wrongKey = "9876543210";
  const plaintext = "Zoë Åström";

  // the plain text, encrypted with the key. All of this is fixed, so that no part of it can be
  // in a message by chance
  const parts = {
    version: "ENC1",
    algorithm: "aes-256-gcm",
    keyId: "L0Ri47-VN098",
    iv: "S-Y4SQyAyFFHog2H",
    ciphertext: "ntgaK-I7Klyu_w1hHQ",
    tag: "PWCuMQBtBYcADaBKSBwqFQ",
  };

  const envelope = (altered: Partial<typeof parts> = {}): string =>
    Object.values({ ...parts, ...altered }).join(".");

  const tooFew = envelope().replace(`.${parts.tag}`, "");
  const tooMany = `${envelope()}.${plaintext}`;

  // every four characters in a row of a secret that are in the text
  const leaked = (text: string, secrets: string[]): string[] =>
    secrets
      .flatMap((secret) =>
        Array.from({ length: secret.length - 3 }, (_, index) =>
          secret.slice(index, index + 4)
        )
      )
      .filter((characters) => text.includes(characters));

  // the name and the arguments of each call to the console
  let logged: unknown[][];

  beforeEach(() => {
    logged = [];
    for (const name of [
      "debug",
      "error",
      "info",
      "log",
      "trace",
      "warn",
    ] as const) {
      jest.spyOn(console, name).mockImplementation((...args: unknown[]) => {
        logged.push([name, ...args]);
      });
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // what is logged of the property called text
  const failed = (cause: string): unknown[] => [
    "error",
    '[es-aggregates] Failed to decrypt PII field "text" — leaving the value as-is to ' +
      `avoid bricking the aggregate. Cause: ${cause}. Investigate: this can indicate ` +
      "tampering or a key mismatch.",
  ];

  // reads an event whose values are stored as they are given here
  const readAsync = async (
    text: string,
    imageUrl: string | undefined,
    encryptionKey: string | undefined
  ): Promise<TestAggregateRoot> => {
    const repo = new Repository(
      new InMemoryEventStore(),
      TestAggregateRoot.factory
    );
    const ar = TestAggregateRoot.create(id, "name");
    ar.createMessage(text, imageUrl);
    await repo.writeAsync(ar); // without a key
    return (await repo.readAsync(id, encryptionKey))!;
  };

  it("should be tested with parts of a right envelope", () => {
    expect(decrypt(envelope(), key)).toBe(plaintext);
  });

  it("should be searched for parts of the value", () => {
    const secrets = ["ENC1.PART-OF-THE-VALUE.x.y.z.t", key];

    expect(leaked("Unsupported: PART.", secrets)).toEqual(["PART"]);
    expect(leaked(`Unsupported: ${key.slice(3, 8)}.`, secrets)).toEqual([
      "3456",
      "4567",
    ]);
    expect(leaked("Unsupported: PAR, 345.", secrets)).toEqual([]);
  });

  describe("for an envelope with another algorithm", () => {
    it.each([
      "aes-256-cbc",
      "AES-256-GCM",
      "aes-256-gcm ",
      "PART-OF-THE-VALUE",
      plaintext,
      "",
    ])("should have exactly this message if it is %p", (algorithm) => {
      expect(() => decrypt(envelope({ algorithm }), key)).toThrow(
        new Error("Unsupported envelope algorithm")
      );
    });

    it("should be logged in one line by a read, which returns the value as it is stored", async () => {
      // arrange
      const stored = "ENC1.PART-OF-THE-VALUE.x.y.z.t";

      // act
      const ar = await readAsync(stored, envelope(), key);

      // assert
      expect(ar.messageText).toBe(stored);
      expect(ar.messageImageUrl).toBe(plaintext); // it is decrypted as usual
      expect(logged).toEqual([failed("Unsupported envelope algorithm")]);
    });
  });

  describe.each<[string, string, string | undefined, string | undefined]>([
    [
      "another algorithm",
      envelope({ algorithm: "aes-256-cbc" }),
      key,
      "Unsupported envelope algorithm",
    ],
    [
      "a text in the place of the algorithm",
      envelope({ algorithm: plaintext }),
      key,
      "Unsupported envelope algorithm",
    ],
    [
      "six parts of odd plain text",
      "ENC1.Zoë Åström.東京都港区.+46 70 123 45 67.1979-03-14.“%s %o”",
      key,
      "Unsupported envelope algorithm",
    ],
    [
      "six parts of odd plain text, one of which is the algorithm",
      "ENC1.aes-256-gcm.東京都港区.+46 70 123 45 67.Zoë Åström.1979-03-14",
      key,
      "Invalid authentication tag length: 7",
    ],
    [
      "a short tag",
      envelope({ tag: parts.tag.slice(0, 6) }),
      key,
      "Invalid authentication tag length: 4",
    ],
    [
      "a long tag",
      envelope({ tag: parts.tag + parts.tag }),
      key,
      "Invalid authentication tag length: 33",
    ],
    [
      "an altered tag",
      envelope({ tag: parts.tag.toLowerCase() }),
      key,
      "Unsupported state or unable to authenticate data",
    ],
    [
      "a tag that is not base64url",
      envelope({ tag: "«¿?¡!»" }),
      key,
      "Invalid authentication tag length: 0",
    ],
    // these three do not count as envelopes, so a read does not try to decrypt them
    ["an empty iv", envelope({ iv: "" }), key, undefined],
    ["a part too few", tooFew, key, undefined],
    ["a part too many", tooMany, key, undefined],
    [
      "a short iv",
      envelope({ iv: parts.iv.slice(0, 6) }),
      key,
      "Unsupported state or unable to authenticate data",
    ],
    [
      "an iv that is not base64url",
      envelope({ iv: "«¿?¡!»" }),
      key,
      "Invalid initialization vector",
    ],
    [
      "an altered ciphertext",
      envelope({ ciphertext: parts.ciphertext.toLowerCase() }),
      key,
      "Unsupported state or unable to authenticate data",
    ],
    [
      "a ciphertext that is not base64url",
      envelope({ ciphertext: "«¿?¡!»" }),
      key,
      "Unsupported state or unable to authenticate data",
    ],
    [
      "parts that are all not base64url",
      envelope({
        keyId: "“%s %o”",
        iv: plaintext,
        ciphertext: "東京都港区",
        tag: "+46 70 123 45 67",
      }),
      key,
      "Invalid authentication tag length: 9",
    ],
    [
      "the wrong key",
      envelope(),
      wrongKey,
      "Unsupported state or unable to authenticate data",
    ],
    [
      "an empty key",
      envelope(),
      "",
      "Unsupported state or unable to authenticate data",
    ],
    ["no key", envelope(), undefined, "no encryption key was provided"],
    [
      "another algorithm, and no key",
      envelope({ algorithm: "aes-256-cbc" }),
      undefined,
      "no encryption key was provided",
    ],
  ])("for a value with %s", (_, stored, encryptionKey, cause) => {
    const secrets = [stored, plaintext, key, wrongKey];

    it("should have no part of it when a read logs the message", async () => {
      // act
      const ar = await readAsync(stored, undefined, encryptionKey);

      // assert
      // inside Jest, an error of Node is not an instance of Error, and is logged with its name
      const lines = logged.map(([name, text, ...others]) => [
        name,
        `${text}`.replace(/Cause: (Type)?Error: /, "Cause: "),
        ...others,
      ]);
      expect(lines).toEqual(cause === undefined ? [] : [failed(cause)]);
      expect(leaked(logged.join(), secrets)).toEqual([]);
      expect(ar.messageText).toBe(stored);
    });

    it("should have no part of it when decrypt throws", () => {
      let error: Error | undefined;
      try {
        decrypt(stored, encryptionKey!);
      } catch (e) {
        error = e as Error;
      }

      expect(error).toHaveProperty("message", expect.stringMatching(/./));
      expect(leaked(error!.message, secrets)).toEqual([]);
    });
  });

  it.each([
    ["plain text", plaintext],
    ["nothing", ""],
    ["another version", envelope({ version: "ENC2" })],
    ["a part too few", tooFew],
    ["a part too many", tooMany],
  ])(
    "should have exactly this message if decrypt is given %s, which is no envelope",
    (_, value) => {
      expect(() => decrypt(value, key)).toThrow(
        new Error("Not a recognised encryption envelope")
      );
    }
  );

  it.each<[string, unknown, string]>([
    ["an object", { name: plaintext }, "object"],
    ["an array", [plaintext], "object"],
    ["a string object", new String(plaintext), "object"],
    ["a number", 46701234567, "number"],
    ["a boolean", true, "boolean"],
  ])(
    "should have exactly this message if a write is to encrypt %s",
    async (_, value, type) => {
      // arrange
      const repo = new Repository(
        new InMemoryEventStore(),
        TestAggregateRoot.factory
      );
      const ar = TestAggregateRoot.create(id, "name");
      ar.createMessage(value as string);

      // act / assert
      await expect(repo.writeAsync(ar, key)).rejects.toThrow(
        new Error(
          `Cannot encrypt encryptedProps field "text": expected a string, got ${type}. ` +
            "Fields declared in an event's encryptedProps must be string-valued."
        )
      );
      expect(logged).toEqual([]);
    }
  );
});
