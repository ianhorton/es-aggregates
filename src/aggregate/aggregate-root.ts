import { EventRecorder } from '../event/event-recorder';
import { EventRouter } from '../event/event-router';
import { IEvent } from '../event/models/event';

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

  public clearChanges = (): void => {
    this._expectedVersion =
      this._expectedVersion + this._recorder.getChangeCount();
    return this._recorder.reset();
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
