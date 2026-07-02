import { IEvent } from './event';

// qp-9k9o: encryptedProps is a STATIC write-time declaration, never persisted —
// the read path is envelope-based. Omit it so it cannot be written to the row.
export interface IPersistedEvent extends Omit<IEvent, 'encryptedProps'> {
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly data: any;
}
