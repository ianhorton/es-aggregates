import { AggregateRoot } from "./aggregate-root";
import { ISnapshotSerializer } from "./snapshot";

/**
 * Default snapshot serializer that handles basic aggregate serialization
 * Uses JSON serialization for simple types and copies all enumerable properties
 */
export class DefaultSnapshotSerializer implements ISnapshotSerializer {
  /**
   * Serialize aggregate to plain object
   * Copies all enumerable properties, including private fields (prefixed with _)
   * Excludes internal EventRecorder and EventRouter instances
   */
  serialize(aggregate: AggregateRoot): Record<string, any> {
    const state: Record<string, any> = {};

    // Get all own properties (including non-enumerable)
    const propertyNames = Object.getOwnPropertyNames(aggregate);

    for (const key of propertyNames) {
      // Skip internal event sourcing infrastructure
      if (key === "_recorder" || key === "_router") {
        continue;
      }

      // Copy property value
      const value = (aggregate as any)[key];

      // Handle different types
      if (value === undefined) {
        continue; // Skip undefined values
      } else if (value === null) {
        state[key] = null;
      } else if (value instanceof Date) {
        state[key] = { __type: "Date", value: value.toISOString() };
      } else if (Array.isArray(value)) {
        state[key] = this.serializeArray(value);
      } else if (typeof value === "object" && value.constructor === Object) {
        state[key] = value; // Plain object
      } else if (typeof value === "object") {
        // Complex object - try to serialize recursively
        state[key] = this.serializeObject(value);
      } else {
        // Primitive types (string, number, boolean)
        state[key] = value;
      }
    }

    return state;
  }

  /**
   * Deserialize plain object back to aggregate state
   * Restores all properties to the aggregate instance
   */
  deserialize(data: Record<string, any>, aggregate: AggregateRoot): void {
    for (const key of Object.keys(data)) {
      // Skip internal infrastructure (shouldn't be in data, but be safe)
      if (key === "_recorder" || key === "_router") {
        continue;
      }

      const value = data[key];

      // Handle different types
      if (value === null || value === undefined) {
        (aggregate as any)[key] = value;
      } else if (this.isDateObject(value)) {
        (aggregate as any)[key] = new Date(value.value);
      } else if (Array.isArray(value)) {
        (aggregate as any)[key] = this.deserializeArray(value);
      } else if (typeof value === "object" && this.isComplexObject(value)) {
        (aggregate as any)[key] = this.deserializeObject(value);
      } else {
        (aggregate as any)[key] = value;
      }
    }
  }

  /**
   * Serialize an array, handling nested objects
   */
  private serializeArray(arr: any[]): any[] {
    return arr.map((item) => {
      if (item === null || item === undefined) {
        return item;
      } else if (item instanceof Date) {
        return { __type: "Date", value: item.toISOString() };
      } else if (Array.isArray(item)) {
        return this.serializeArray(item);
      } else if (typeof item === "object") {
        return this.serializeObject(item);
      } else {
        return item;
      }
    });
  }

  /**
   * Deserialize an array, handling nested objects
   */
  private deserializeArray(arr: any[]): any[] {
    return arr.map((item) => {
      if (item === null || item === undefined) {
        return item;
      } else if (this.isDateObject(item)) {
        return new Date(item.value);
      } else if (Array.isArray(item)) {
        return this.deserializeArray(item);
      } else if (typeof item === "object" && this.isComplexObject(item)) {
        return this.deserializeObject(item);
      } else {
        return item;
      }
    });
  }

  /**
   * Serialize a complex object
   */
  private serializeObject(obj: any): Record<string, any> {
    const result: Record<string, any> = {};

    // Get all property names
    const propertyNames = Object.getOwnPropertyNames(obj);

    for (const key of propertyNames) {
      const value = obj[key];

      if (value === undefined) {
        continue;
      } else if (value === null) {
        result[key] = null;
      } else if (value instanceof Date) {
        result[key] = { __type: "Date", value: value.toISOString() };
      } else if (Array.isArray(value)) {
        result[key] = this.serializeArray(value);
      } else if (typeof value === "object") {
        result[key] = this.serializeObject(value);
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * Deserialize a complex object
   */
  private deserializeObject(obj: Record<string, any>): Record<string, any> {
    const result: Record<string, any> = {};

    for (const key of Object.keys(obj)) {
      const value = obj[key];

      if (value === null || value === undefined) {
        result[key] = value;
      } else if (this.isDateObject(value)) {
        result[key] = new Date(value.value);
      } else if (Array.isArray(value)) {
        result[key] = this.deserializeArray(value);
      } else if (typeof value === "object" && this.isComplexObject(value)) {
        result[key] = this.deserializeObject(value);
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * Check if value is a serialized Date object
   */
  private isDateObject(value: any): boolean {
    return (
      typeof value === "object" &&
      value !== null &&
      value.__type === "Date" &&
      typeof value.value === "string"
    );
  }

  /**
   * Check if value is a complex object (not a Date marker)
   */
  private isComplexObject(value: any): boolean {
    return typeof value === "object" && value !== null && !this.isDateObject(value);
  }
}
