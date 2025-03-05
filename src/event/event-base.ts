import { zonedTimeToUtc } from 'date-fns-tz';

import { IEvent } from './models/event';

export abstract class EventBase implements IEvent {
  public readonly timestamp: string = zonedTimeToUtc(
    new Date(),
    Intl.DateTimeFormat().resolvedOptions().timeZone
  ).toISOString();
  constructor(
    public readonly eventType: string,
    public readonly encryptedProps?: string[]
  ) {}
}
