export interface IEvent {
  readonly encryptedProps?: Array<string>;
  readonly eventType: string;
  readonly timestamp: string;
}
