import { IPersistedEvent } from "../event/models/persisted-event";

/**
 * A value that JSON can hold.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;

/**
 * An object that JSON can hold.
 */
export interface JsonObject {
  [name: string]: JsonValue;
}

export interface JsonEventCopyOptions {
  /**
   * Checks each string that is copied, and throws to refuse one that the database cannot
   * hold. The path tells where the string is, such as "ItemAdded.data.tags[0]".
   */
  readonly checkString?: (value: string, path: string) => void;

  /**
   * Checks the name of each property that is copied, before its value is copied, and
   * throws to refuse one that the database cannot hold. The path is that of the object
   * that has the property, such as "ItemAdded.data", so the name is not in it.
   */
  readonly checkPropertyName?: (name: string, path: string) => void;
}

/**
 * Copies an event into one that JSON can hold and reads back as it is, for a store that
 * keeps events as JSON.
 *
 * The copy has the strings, booleans, nulls and finite numbers of the event, and copies
 * of its plain objects and arrays, also those of another vm context, and of objects
 * without a prototype. It leaves out what DynamoEventStore leaves out: undefined values,
 * at any depth, and properties that are functions. It also leaves out properties that
 * have a symbol for a name, as JSON does. JSON writes -0 as 0.
 *
 * Anything else is refused, because JSON would change it, or cannot hold it: NaN and the
 * infinities, a bigint, a symbol, a function in an array, and an instance of a class, such
 * as a Date, a Map or a Buffer. The error tells where the value is, from the event's
 * type: "Cannot store ItemAdded.data.when, because JSON cannot hold an instance of Date."
 */
export class JsonEventCopy {
  /**
   * @param options checks for a database that cannot hold some strings or property names
   */
  constructor(private readonly options: JsonEventCopyOptions = {}) {}

  /**
   * A copy of the event, which shares no object with it. The event does not change. The
   * copy's objects have no prototype.
   */
  public of = (event: IPersistedEvent): JsonObject =>
    this.toJson(event, event.eventType) as JsonObject;

  private toJson = (value: unknown, path: string): JsonValue => {
    if (this.isPlainArray(value)) {
      const copy: JsonValue[] = [];
      value.forEach((element, index) => {
        if (element !== undefined) {
          copy.push(this.toJson(element, `${path}[${index}]`));
        }
      });
      return copy;
    }

    if (this.isPlainObject(value)) {
      // it has no prototype, so that __proto__ is a property like any other
      const copy: JsonObject = Object.create(null);
      for (const [name, property] of Object.entries(value)) {
        if (property !== undefined && typeof property !== "function") {
          this.options.checkPropertyName?.(name, path);
          copy[name] = this.toJson(property, `${path}.${name}`);
        }
      }
      return copy;
    }

    if (typeof value === "string") {
      this.options.checkString?.(value, path);
      return value;
    }

    if (
      value === null ||
      typeof value === "boolean" ||
      Number.isFinite(value)
    ) {
      return value as JsonValue;
    }

    throw new Error(
      `Cannot store ${path}, because JSON cannot hold ${this.describe(value)}.`
    );
  };

  // These two do not compare a prototype with Array.prototype or Object.prototype,
  // because each vm context has its own. Array.prototype is itself an array, and
  // Object.prototype has no prototype

  private isPlainArray = (value: unknown): value is unknown[] =>
    Array.isArray(value) && Array.isArray(Object.getPrototypeOf(value));

  private isPlainObject = (
    value: unknown
  ): value is Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || Object.getPrototypeOf(prototype) === null;
  };

  private describe = (value: unknown): string => {
    if (typeof value === "object") {
      return `an instance of ${(value as object).constructor?.name}`;
    }
    return typeof value === "number" ? `${value}` : `a ${typeof value}`;
  };
}
