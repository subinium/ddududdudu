import { randomUUID } from 'node:crypto';

import type { Multiplexer, PaneInfo } from './interface.js';

interface VirtualPane {
  id: string;
  name: string;
  cwd: string;
  active: boolean;
  width: number;
  height: number;
  inputBuffer: string[];
  outputBuffer: string[];
}

const DEFAULT_WIDTH = 120;
const DEFAULT_HEIGHT = 36;

export class BuiltinMultiplexer implements Multiplexer {
  public readonly name = 'builtin';
  private readonly panes = new Map<string, VirtualPane>();

  public async createWindow(params: { name: string; cwd: string }): Promise<string> {
    const pane = this.buildPane(params.name, params.cwd);
    this.setActivePane(pane.id);
    this.panes.set(pane.id, pane);
    return pane.id;
  }

  public async splitPane(targetId: string, direction: 'h' | 'v', cwd: string): Promise<string> {
    const target = this.panes.get(targetId);
    const baseName = target?.name ?? 'pane';
    const pane = this.buildPane(`${baseName}-${direction}`, cwd);
    this.setActivePane(pane.id);
    this.panes.set(pane.id, pane);
    return pane.id;
  }

  public async sendKeys(paneId: string, command: string): Promise<void> {
    const pane = this.panes.get(paneId);
    if (!pane) {
      throw new Error(`Pane not found: ${paneId}`);
    }

    pane.inputBuffer.push(command);
    pane.outputBuffer.push(`$ ${command}`);
  }

  public async capturePane(paneId: string, lines?: number): Promise<string | null> {
    const pane = this.panes.get(paneId);
    if (!pane) {
      return null;
    }

    const output =
      typeof lines === 'number' && Number.isFinite(lines) && lines > 0
        ? pane.outputBuffer.slice(-Math.floor(lines))
        : pane.outputBuffer;

    return output.join('\n');
  }

  public async killPane(paneId: string): Promise<void> {
    this.panes.delete(paneId);
  }

  public async listPanes(): Promise<PaneInfo[]> {
    return Array.from(this.panes.values()).map((pane: VirtualPane) => ({
      id: pane.id,
      name: pane.name,
      active: pane.active,
      width: pane.width,
      height: pane.height,
    }));
  }

  public requiresFocusForInput(): boolean {
    return false;
  }

  private buildPane(name: string, cwd: string): VirtualPane {
    return {
      id: `builtin-${randomUUID()}`,
      name,
      cwd,
      active: false,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      inputBuffer: [],
      outputBuffer: [],
    };
  }

  private setActivePane(id: string): void {
    for (const pane of this.panes.values()) {
      pane.active = pane.id === id;
    }
  }
}
