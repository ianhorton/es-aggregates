import { EventRouter } from '../event/event-router';
import { IEvent } from '../event/models/event';

export abstract class Entity {
  private readonly _applier: (e: IEvent) => void;
  private readonly _router: EventRouter;

  constructor(applier: (e: any) => void) {
    this._applier = applier;
    this._router = new EventRouter();
  }

  protected register = (type: string, handler: (e: any) => void) => {
    this._router.configureRoute(type, handler);
  };

  public route = (e: IEvent) => {
    this._router.route(e);
  };

  public apply = (e: IEvent) => {
    this._applier(e);
  };
}
