import { IEvent } from "./models/event";

export class EventRouter {
  readonly _handlers: { [type: string]: (e: IEvent) => void };

  constructor() {
    this._handlers = {};
  }

  public configureRoute(type: string, handler: (e: IEvent) => void): void {
    // null checks
    this._handlers[type] = handler;
  }

  public route(e: IEvent): void {
    const handler = this._handlers[e.eventType];
    if (handler) {
      handler(e);
    } else {
      throw new Error(
        `Handler not found for Event "${e.eventType}", did you forget to register it?`
      );
    }
  }
}
