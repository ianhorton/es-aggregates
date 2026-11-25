import { EventRecorder } from "../event/event-recorder";
import { EventRouter } from "../event/event-router";
import { IEvent } from "../event/models/event";

export abstract class AggregateRoot {
  public abstract id: string;

  private readonly _recorder: EventRecorder;
  private readonly _router: EventRouter;

  private _expectedVersion: number;

  constructor() {
    this._recorder = new EventRecorder();
    this._router = new EventRouter();
    this._expectedVersion = 0;
  }

  public initialize = (events: Array<IEvent>) => {
    for (let index = 0; index < events.length; index++) {
      this.play(events[index]);
      this._expectedVersion = this._expectedVersion + 1;
    }
  };

  public getExpectedVersion = (): number => this._expectedVersion;

  public hasChanges = (): boolean => {
    return this._recorder.hasChanges();
  };

  public getChanges = (): Array<IEvent> => {
    return this._recorder.getChanges();
  };

  /**
   * Clears the changes, because they are stored, and expects the version after them.
   *
   * @param lastVersion the version of the last change that is stored. Those after it were
   * made while it was being stored, and are kept. Without it, all changes are cleared
   */
  public clearChanges = (lastVersion?: number): void => {
    // the first change has the expected version. That is past lastVersion if something else,
    // such as the write of another repository, has cleared the changes already
    const count =
      typeof lastVersion === "number"
        ? Math.max(lastVersion + 1 - this._expectedVersion, 0)
        : this._recorder.getChangeCount();

    this._recorder.removeFirst(count);
    this._expectedVersion = this._expectedVersion + count;
  };

  protected register = (type: string, handler: (e: any) => void) => {
    this._router.configureRoute(type, handler);
  };

  protected applyChange = (e: IEvent) => {
    this.play(e);
    this.record(e);
  };

  private play = (e: IEvent) => {
    this._router.route(e);
  };

  private record = (e: IEvent) => {
    this._recorder.record(e);
  };
}
