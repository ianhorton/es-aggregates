import { EventBase } from "../../../src";

// MessageCreated-shaped: both text and imageUrl are PII (allow-listed for
// encryption) but any given message populates only one of them.
export class TestMessageCreated extends EventBase {
  public static typename = "TestMessageCreated";
  constructor(
    public readonly id: string,
    public readonly text?: string,
    public readonly imageUrl?: string
  ) {
    super(TestMessageCreated.typename, ["text", "imageUrl"]);
  }
}
