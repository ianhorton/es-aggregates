import { EventBase } from "@es-aggregates/core";

// Uses the NEW static-field declaration form. `secret` is PII;
// `plain` is deliberately NOT declared, to prove read-scoping.
export class TestSecretCreated extends EventBase {
  public static eventType = "TestSecretCreated";
  public static encryptedProps = ["secret"];

  constructor(
    public readonly id: string,
    public readonly secret?: string,
    public readonly plain?: string
  ) {
    super();
  }
}
