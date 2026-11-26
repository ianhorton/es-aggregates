import { Queryable } from "../../src";

// what the store sent
export interface Sent {
  text: string;
  values: unknown[];
}

/**
 * A pool without a database. It records what the store sends it, and answers each
 * statement as the test tells it.
 */
export class RecordingPool implements Queryable {
  public readonly sent: Sent[] = [];

  constructor(
    private readonly answer: () => Promise<{ rows: unknown[] }> = () =>
      Promise.resolve({ rows: [] })
  ) {}

  public query = (text: string, values: unknown[]) => {
    this.sent.push({ text, values: [...values] });
    return this.answer();
  };
}
