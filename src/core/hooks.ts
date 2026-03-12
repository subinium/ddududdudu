export type HookEvent =
  | 'beforeToolCall'
  | 'afterToolCall'
  | 'beforeApiCall'
  | 'afterApiCall'
  | 'onSessionStart'
  | 'onSessionEnd'
  | 'onModeSwitch'
  | 'onError'
  | 'beforeSend'
  | 'afterResponse';

export interface HookContext {
  event: HookEvent;
  timestamp: number;
  data: Record<string, unknown>;
}

export type HookHandler = (ctx: HookContext) => Promise<void> | void;

const HOOK_EVENTS: HookEvent[] = [
  'beforeToolCall',
  'afterToolCall',
  'beforeApiCall',
  'afterApiCall',
  'onSessionStart',
  'onSessionEnd',
  'onModeSwitch',
  'onError',
  'beforeSend',
  'afterResponse',
];

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

export class HookRegistry {
  private readonly handlers: Map<HookEvent, Set<HookHandler>>;

  public constructor() {
    this.handlers = new Map<HookEvent, Set<HookHandler>>();
    for (const event of HOOK_EVENTS) {
      this.handlers.set(event, new Set<HookHandler>());
    }
  }

  public on(event: HookEvent, handler: HookHandler): () => void {
    const eventHandlers = this.handlers.get(event);
    if (!eventHandlers) {
      return () => {
        return;
      };
    }

    eventHandlers.add(handler);

    return (): void => {
      eventHandlers.delete(handler);
    };
  }

  public async emit(event: HookEvent, data: Record<string, unknown>): Promise<void> {
    const eventHandlers = this.handlers.get(event);
    if (!eventHandlers || eventHandlers.size === 0) {
      return;
    }

    const tasks = Array.from(eventHandlers).map(async (handler: HookHandler): Promise<void> => {
      const context: HookContext = {
        event,
        timestamp: Date.now(),
        data: { ...data },
      };

      await handler(context);
    });

    const results = await Promise.allSettled(tasks);

    for (const result of results) {
      if (result.status === 'rejected') {
        console.error(`[HookRegistry] Hook handler failed during emit for event "${event}".`, result.reason);
      }
    }
  }

  public async waterfall(event: HookEvent, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const eventHandlers = this.handlers.get(event);
    if (!eventHandlers || eventHandlers.size === 0) {
      return { ...data };
    }

    let currentData: Record<string, unknown> = { ...data };

    for (const handler of eventHandlers) {
      const context: HookContext = {
        event,
        timestamp: Date.now(),
        data: currentData,
      };

      try {
        await handler(context);
        currentData = isRecord(context.data) ? context.data : currentData;
      } catch (error: unknown) {
        console.error(`[HookRegistry] Waterfall hook failed for event "${event}".`, error);
      }
    }

    return currentData;
  }

  public clear(): void {
    for (const handlers of this.handlers.values()) {
      handlers.clear();
    }
  }

  public stats(): Record<HookEvent, number> {
    const counts: Record<HookEvent, number> = {
      beforeToolCall: 0,
      afterToolCall: 0,
      beforeApiCall: 0,
      afterApiCall: 0,
      onSessionStart: 0,
      onSessionEnd: 0,
      onModeSwitch: 0,
      onError: 0,
      beforeSend: 0,
      afterResponse: 0,
    };

    for (const event of HOOK_EVENTS) {
      counts[event] = this.handlers.get(event)?.size ?? 0;
    }

    return counts;
  }
}
