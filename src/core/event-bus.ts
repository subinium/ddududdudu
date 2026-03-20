export type HarnessEvent =
  | { type: 'request_start'; provider: string; model: string; mode: string }
  | { type: 'request_phase'; label: string; provider: string; model: string; toolTurn?: number }
  | { type: 'tool_execution'; names: string[]; count: number }
  | { type: 'loop_detected'; name: string; count: number; message: string }
  | { type: 'verification_progress'; label: string; completed: number; total: number }
  | { type: 'verification_complete'; status: 'passed' | 'failed' | 'skipped'; summary: string };

type Listener = (event: HarnessEvent) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  public emit(event: HarnessEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
