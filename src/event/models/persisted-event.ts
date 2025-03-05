import { IEvent } from './event';

export interface IPersistedEvent extends IEvent {
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly data: any;
}
