import { IEvent } from './event';

// encryptedProps IS persisted, but as a SCOPE-ONLY marker — the FAITHFUL
// static array the event declares (never the runtime "what was actually
// encrypted"). It bounds which fields the read path inspects; the ENC1 sentinel
// on the value itself is the sole is-encrypted signal.
export interface IPersistedEvent extends IEvent {
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly data: any;
}
