import { Logger, LogLevel } from "@sailplane/logger";

import { IEvent } from "../event/models/event";
import { IPersistedEvent } from "../event/models/persisted-event";
import { EventStore } from "../store/event-store";
import { AggregateRoot } from "./aggregate-root";
import { decrypt, encrypt, isEncrypted } from "./encryption";

export interface IRepository<T extends AggregateRoot> {
  readonly readAsync: (
    id: string,
    encryptionKey?: string
  ) => Promise<T | undefined>;

  readonly writeAsync: (aggregate: T, encryptionKey?: string) => Promise<void>;
}

export class Repository<T extends AggregateRoot> implements IRepository<T> {
  // For ids, event types, versions and counts only. The values of events must not get into
  // the logs, so never give it data, a key, or an error, which can have values in it. It is
  // not called logger, because a subclass may have one of its own.
  private readonly debugLogger: Logger;

  constructor(
    private readonly store: EventStore,
    private readonly activator: () => T,
    readonly debug: boolean = false
  ) {
    this.debugLogger = new Logger({
      module: "repository",
      level: debug ? LogLevel.DEBUG : LogLevel.NONE,
    });
  }

  public readAsync = async (
    id: string,
    encryptionKey?: string
  ): Promise<T | undefined> => {
    const events = await this.readEventsAsync(id, encryptionKey);

    if (events.length > 0) {
      const aggregate = this.activator();
      aggregate.initialize(events);
      return aggregate;
    }

    return undefined;
  };

  public writeAsync = async (aggregate: T, encryptionKey?: string): Promise<void> => {
    const changes = aggregate.getChanges();

    if (changes.length === 0) {
      this.debugLogger.debug("No changes to write.", {
        aggregateId: aggregate.id,
      });
      return;
    }

    const expectedVersion = aggregate.getExpectedVersion();
    this.debugLogger.debug("Writing changes.", {
      aggregateId: aggregate.id,
      expectedVersion,
      eventTypes: changes.map(({ eventType }) => eventType),
    });

    await this.appendEventsAsync(
      aggregate.id,
      changes,
      expectedVersion,
      encryptionKey
    );

    aggregate.clearChanges();
  };

  /**
   * Encrypt the write-time-declared PII fields. `encryptedProps` is the STATIC
   * per-event-type declaration of which props carry PII (used only to select
   * fields here). With no key, values are left plaintext — they carry no
   * envelope, so the read path never decrypts them. Returns a new object.
   */
  private encryptData = (
    props: Record<string, unknown>,
    encryptionKey?: string,
    encryptedProps?: string[]
  ): Record<string, unknown> => {
    if (encryptionKey === undefined || encryptedProps === undefined) {
      return props;
    }
    const result: Record<string, unknown> = { ...props };
    for (const propertyName of encryptedProps) {
      const value = result[propertyName];
      // An allow-listed field may be absent on a given event (e.g. a
      // MessageCreated lists both text and imageUrl but populates only one).
      // Skip absent fields so encrypt is never called with undefined, and keep
      // absent as absent (do NOT coerce to "").
      if (value !== undefined && value !== null) {
        // encryptedProps is a STRING-ONLY contract. Fail loudly on a non-string
        // rather than String()-coercing (which would silently persist
        // "[object Object]" and read back a corrupted value) — restoring the
        // loud failure the old CBC path gave. (review comment #1)
        if (typeof value !== "string") {
          throw new Error(
            `Cannot encrypt encryptedProps field "${propertyName}": expected a string, got ${typeof value}. ` +
              `Fields declared in an event's encryptedProps must be string-valued.`
          );
        }
        result[propertyName] = encrypt(value, encryptionKey);
      }
    }
    return result;
  };

  /**
   * Decrypt PII fields on read. Two independent gates:
   *
   *  1. SCOPE — only the fields named in the row's `encryptedProps` marker are
   *     inspected at all (the faithful static declaration). Non-PII fields are
   *     never touched, whatever their value → bounded blast radius.
   *  2. SIGNAL — within scope, the ENC1 envelope sentinel on the VALUE decides
   *     decrypt-vs-passthrough. The marker is SCOPE-ONLY: presence in it does NOT
   *     mean "is encrypted" (that would reintroduce the decrypt-on-
   *     plaintext landmine). A plaintext scoped field passes through untouched.
   *
   * A declared-PII envelope that fails to decrypt (GCM auth failure — tampering
   * or wrong key — or a missing key) is passed through UNCHANGED so a bad value
   * cannot brick the whole aggregate, but is logged loudly so genuine tampering
   * surfaces. Availability is chosen over hard-fail; the loud log is the
   * tamper-detection signal.
   */
  private decryptData = (
    data: Record<string, unknown>,
    encryptionKey?: string,
    encryptedProps?: string[]
  ): Record<string, unknown> => {
    if (!encryptedProps || encryptedProps.length === 0) {
      return data;
    }
    const result: Record<string, unknown> = { ...data };
    for (const name of encryptedProps) {
      const value = result[name];
      // SIGNAL: only an actual envelope is decrypted — plaintext passes through.
      if (!isEncrypted(value)) {
        continue;
      }
      try {
        if (encryptionKey === undefined) {
          throw new Error("no encryption key was provided");
        }
        result[name] = decrypt(value, encryptionKey);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // Log loudly regardless of the debug logger level — this is a
        // security-relevant event (possible tampering or key mismatch).
        // eslint-disable-next-line no-console
        console.error(
          `[es-aggregates] Failed to decrypt PII field "${name}" — leaving the ` +
            `value as-is to avoid bricking the aggregate. Cause: ${reason}. ` +
            `Investigate: this can indicate tampering or a key mismatch.`
        );
      }
    }
    return result;
  };

  private appendEventsAsync = async (
    aggregateId: string,
    changes: IEvent[],
    expectedVersion: number,
    encryptionKey?: string
  ): Promise<void> => {
    const persistedEvents: IPersistedEvent[] = [];

    for (let index = 0; index < changes.length; index++) {
      const event = changes[index];
      const { eventType, timestamp, encryptedProps, ...otherProps } = event;

      // Persist encryptedProps as a SCOPE-ONLY marker: the FAITHFUL static array
      // exactly as the event declares it — NOT the runtime "what was actually
      // encrypted" runtime version. It bounds which fields the read path
      // inspects; the ENC1 sentinel on each value is the sole is-encrypted
      // signal, so a plaintext (key-less) write still carries the marker but is
      // never decrypted on read.
      const persistedEvent: IPersistedEvent = {
        aggregateId,
        eventType,
        timestamp,
        aggregateVersion: expectedVersion + index,
        encryptedProps,
        data: this.encryptData(
          otherProps as Record<string, unknown>,
          encryptionKey,
          encryptedProps
        ),
      };

      persistedEvents.push(persistedEvent);
    }

    await this.store.appendAsync(aggregateId, persistedEvents, expectedVersion);
  };

  private readEventsAsync = async (
    aggregateId: string,
    encryptionKey?: string
  ): Promise<IEvent[]> => {
    const items = await this.store.readAsync(aggregateId);
    this.debugLogger.debug("Read items.", {
      aggregateId,
      items: items.map(({ aggregateVersion, eventType }) => ({
        aggregateVersion,
        eventType,
      })),
    });

    if (items.length > 0) {
      const events = items.map(
        ({ eventType, timestamp, encryptedProps, data }) => {
          // Scope decryption to the row's faithful marker; within it, the ENC1
          // sentinel on each value decides decrypt-vs-passthrough.
          const decryptedData = this.decryptData(
            data,
            encryptionKey,
            encryptedProps
          );

          const event: IEvent = {
            eventType,
            timestamp,
            encryptedProps,
            ...decryptedData,
          };

          return event;
        }
      );
      return events;
    } else {
      const e: IEvent[] = [];
      return e;
    }
  };
}
