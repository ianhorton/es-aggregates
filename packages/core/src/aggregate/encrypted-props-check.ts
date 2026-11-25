import { IEvent } from "../event/models/event";
import { IPersistedEvent } from "../event/models/persisted-event";

/**
 * Warns if what the author of an event lists as private is stored as plain text all the
 * same, by a write that has a key. A warning has the event's type in it, and a name that is
 * listed, but never a value. Each is given once per process, so as not to flood the logs.
 */
export class EncryptedPropsCheck {
  // the warnings that have been given
  private static readonly given = new Set<string>();

  /**
   * @param event as it was recorded
   * @param persistedEvent the same event, as it is about to be stored
   */
  constructor(
    private readonly event: IEvent,
    private readonly persistedEvent: IPersistedEvent
  ) {}

  /**
   * This must not fail the write, whatever kind of object the event is, and even if the
   * console throws.
   */
  public warn = (): void => {
    try {
      this.warnings().forEach(this.giveOnce);
    } catch {
      // the write goes ahead
    }
  };

  private warnings = (): string[] => {
    const { encryptedProps } = this.persistedEvent;
    if (encryptedProps === undefined) {
      return this.hasStaticList() ? [this.staticListNotUsed()] : [];
    }
    return [...encryptedProps].filter(this.isNotInData).map(this.nameNotInData);
  };

  /**
   * The data has a property that is undefined. It does not have one that the event lacks,
   * because the name is misspelt, or is a path, or the property is optional. Nor does it
   * have eventType, timestamp and encryptedProps, which are never encrypted.
   */
  private isNotInData = (name: string): boolean =>
    !(name in this.persistedEvent.data);

  private nameNotInData = (name: string): string =>
    `[es-aggregates] Event "${this.persistedEvent.eventType}" lists "${name}" in ` +
    "encryptedProps, but its data has no property of that name, so nothing is encrypted " +
    "for it. Check the spelling: if another property is meant, its value is stored as " +
    "plain text. Only the event's own properties can be encrypted, other than eventType " +
    'and timestamp, and not one inside an object, such as "address.city". If the ' +
    "property is optional, and this event does not have it, you can ignore this.";

  private hasStaticList = (): boolean => {
    // not this.event.constructor, because an event can have a property of that name
    const eventClass = Object.getPrototypeOf(this.event)?.constructor;
    const list: unknown = eventClass?.encryptedProps;
    return Array.isArray(list) && list.length > 0;
  };

  private staticListNotUsed = (): string =>
    `[es-aggregates] Event "${this.persistedEvent.eventType}" has no encryptedProps, ` +
    "although its class declares static encryptedProps, so nothing of it is encrypted: " +
    "its values are stored as plain text. The static list is not used if the constructor " +
    "passes the event's type to super. Declare static eventType too, and call super() " +
    "without arguments. If no list is passed on purpose, to switch encryption off, you " +
    "can ignore this.";

  private giveOnce = (warning: string): void => {
    const { given } = EncryptedPropsCheck;
    if (!given.has(warning)) {
      given.add(warning);
      // eslint-disable-next-line no-console
      console.warn(warning);
    }
  };
}
