import type { EventSourceLike } from '../../src/api/stream';

type Listener = (event: MessageEvent | Event) => void;

/** Stands in for the browser's EventSource; tests drive `open`, `state`, `ping` and `error`. */
export class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', new Event('open'));
  }

  send(type: 'state' | 'ping', data: unknown, id?: string): void {
    this.emit(
      type,
      new MessageEvent(type, {
        data: typeof data === 'string' ? data : JSON.stringify(data),
        lastEventId: id,
      }),
    );
  }

  fail(fatal = false): void {
    if (fatal) this.readyState = 2;
    this.emit('error', new Event('error'));
  }

  private emit(type: string, event: MessageEvent | Event): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}
