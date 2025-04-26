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
    // null checks
    this._recorded.push(event);
  }

  public reset(): void {
    this._recorded.length = 0;
  }
}
