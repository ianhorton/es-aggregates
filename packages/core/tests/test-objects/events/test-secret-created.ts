import { EventBase } from "../../../src";

// Uses the NEW static-field declaration form (qp-9k9o). `secret` is PII;
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
