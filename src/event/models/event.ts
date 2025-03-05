export interface IEvent {
  readonly encryptedProps?: string[];
  readonly eventType: string;
  readonly timestamp: string;
}
