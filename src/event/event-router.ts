import { IEvent } from "./models/event";

type eventFunction = (e: IEvent) => void;
export class EventRouter {
  private readonly _handlers: Map<string, eventFunction>;

  constructor() {
    this._handlers = new Map<string, eventFunction>();
  }

  public configureRoute(type: string, handler: eventFunction): void {
    // TODO: null checks
    this._handlers.set(type, handler);
  }

  public route(e: IEvent): void {
    // TODO: null checks
    const handler = this._handlers.get(e.eventType);
    if (handler) {
      handler(e);
    } else {
      throw new Error(
        `Handler not found for Event "${e.eventType}", did you forget to register it?`
      );
    }
  }
}
