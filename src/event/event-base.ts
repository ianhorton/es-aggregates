import { zonedTimeToUtc } from 'date-fns-tz';

import { IEvent } from './models/event';

// Deprecation is warned once per event type (not per instance) to avoid spam.
const warnedConstructorArgTypes = new Set<string>();

/**
 * Base class for domain events.
 *
 * `eventType` and `encryptedProps` are immutable per-class metadata and may be
 * declared as STATIC class fields (preferred):
 *
 *   class UserRenamed extends EventBase {
 *     static eventType = "UserRenamed";
 *     static encryptedProps = ["displayName"];
 *     constructor(public readonly displayName: string) { super(); }
 *   }
 *
 * The legacy constructor-arg form still works but is DEPRECATED (removal is a
 * future 2.0.0):
 *
 *   super("UserRenamed", ["displayName"]);
 *
 * When the constructor arg is provided it wins (and warns once); otherwise the
 * base falls back to the subclass's static fields.
 */
export abstract class EventBase implements IEvent {
  public readonly eventType: string;
  public readonly encryptedProps?: Array<string>;
  public readonly timestamp: string = zonedTimeToUtc(
    new Date(),
    Intl.DateTimeFormat().resolvedOptions().timeZone
  ).toISOString();

  constructor(eventType?: string, encryptedProps?: Array<string>) {
    if (eventType !== undefined) {
      // Legacy form: explicit constructor args. Warn once per type.
      if (!warnedConstructorArgTypes.has(eventType)) {
        warnedConstructorArgTypes.add(eventType);
        // eslint-disable-next-line no-console
        console.warn(
          `[es-aggregates] Event "${eventType}" passes eventType/encryptedProps as ` +
            `constructor arguments. This is deprecated — declare them as static class ` +
            `fields instead (removal is a future major). See EventBase docs.`
        );
      }
      this.eventType = eventType;
      this.encryptedProps = encryptedProps;
      return;
    }

    // Preferred form: static class fields on the subclass.
    const ctor = this.constructor as {
      eventType?: string;
      encryptedProps?: Array<string>;
    };
    if (ctor.eventType === undefined) {
      throw new Error(
        `${this.constructor.name}: eventType must be declared, either as a static ` +
          `class field (preferred) or a constructor argument.`
      );
    }
    this.eventType = ctor.eventType;
    this.encryptedProps = ctor.encryptedProps;
  }
}
