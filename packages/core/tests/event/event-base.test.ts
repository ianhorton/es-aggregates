import { EventBase } from "../../src";

// NEW preferred form: static class fields.
class StaticEvent extends EventBase {
  public static eventType = "StaticEventUnique";
  public static encryptedProps = ["foo"];
  constructor(public readonly foo: string) {
    super();
  }
}

class StaticNoEncrypted extends EventBase {
  public static eventType = "StaticNoEnc";
  constructor(public readonly foo: string) {
    super();
  }
}

// LEGACY form: constructor args (deprecated).
class LegacyEvent extends EventBase {
  constructor(public readonly foo: string) {
    super("LegacyEventUnique", ["foo"]);
  }
}

// Misconfigured: neither a static eventType nor a constructor arg.
class BrokenEvent extends EventBase {
  constructor() {
    super();
  }
}

describe("EventBase (qp-9k9o dual-support)", () => {
  it("(e) reads eventType + encryptedProps from static class fields (new form)", () => {
    const e = new StaticEvent("x");
    expect(e.eventType).toBe("StaticEventUnique");
    expect(e.encryptedProps).toEqual(["foo"]);
    expect(typeof e.timestamp).toBe("string");
  });

  it("static form leaves encryptedProps undefined when not declared", () => {
    const e = new StaticNoEncrypted("x");
    expect(e.eventType).toBe("StaticNoEnc");
    expect(e.encryptedProps).toBeUndefined();
  });

  it("(d) legacy constructor-arg form still works and warns ONCE per type", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const a = new LegacyEvent("1");
    const b = new LegacyEvent("2");

    expect(a.eventType).toBe("LegacyEventUnique");
    expect(a.encryptedProps).toEqual(["foo"]);
    expect(b.eventType).toBe("LegacyEventUnique");

    // Warned exactly once for this type despite two instances.
    const warnsForType = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("LegacyEventUnique")
    );
    expect(warnsForType).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it("throws when neither a static eventType nor a constructor arg is provided", () => {
    expect(() => new BrokenEvent()).toThrow(/eventType must be declared/i);
  });
});
