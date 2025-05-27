import { IEvent } from "./models/event";

export class EventRecorder {
  private readonly _recorded: Array<IEvent>;

  constructor() {
    this._recorded = [];
  }

  public hasChanges(): boolean {
    return this._recorded.length > 0;
  }

  public getChanges(): Array<IEvent> {
    return this._recorded;
  }

  public getChangeCount(): number {
    return this._recorded.length;
  }

  public record(event: IEvent): void {
    // this is a bit sukky because this limit actually comes from dynamo, so it is funky to be managing that here
    // not really a massive issue until we decide to support other persistence mechanisms...
    if (this._recorded.length === 100) {
      throw new Error(
        "Event Recorder limit of 100 in memory changes exceeded. Consider writing changes with repository more frequently."
      );
    }
    this._recorded.push(event);
  }

  public reset(): void {
    this._recorded.length = 0;
  }
}
