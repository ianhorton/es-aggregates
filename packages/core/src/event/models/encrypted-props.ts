import { IEvent } from "./event";

/**
 * A type for an event's list of properties to encrypt, so that TypeScript checks the names:
 *
 *   class UserRenamed extends EventBase {
 *     static eventType = "UserRenamed";
 *     static encryptedProps: EncryptedProps<UserRenamed> = ["displayName"];
 *     constructor(public readonly displayName: string) { super(); }
 *   }
 *
 * A name that is not a public property of the event is an error. So is one whose value can
 * be something other than a string, null or undefined, because only strings are encrypted.
 * So are eventType, timestamp and encryptedProps, which are never encrypted.
 *
 * If another event class extends this one and lists more names, leave the type out here,
 * because TypeScript wants the static properties of the two to fit each other.
 */
export type EncryptedProps<TEvent extends IEvent> = Array<
  {
    [K in DataName<TEvent>]-?: TEvent[K] extends string | null | undefined
      ? K
      : never;
  }[DataName<TEvent>]
>;

/** The names of the event's public properties, other than those that every event has. */
type DataName<TEvent extends IEvent> = Exclude<
  keyof TEvent & string,
  keyof IEvent
>;
