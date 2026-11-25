import { EventBase } from "@es-aggregates/core";

// `secret` is PII; `plain` is deliberately NOT declared, to prove read-scoping.
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
