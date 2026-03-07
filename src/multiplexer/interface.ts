export interface PaneInfo {
  id: string;
  name: string;
  active: boolean;
  width: number;
  height: number;
}

export interface Multiplexer {
  name: string;
  createWindow(params: { name: string; cwd: string }): Promise<string>;
  splitPane(targetId: string, direction: 'h' | 'v', cwd: string): Promise<string>;
  sendKeys(paneId: string, command: string): Promise<void>;
  capturePane(paneId: string, lines?: number): Promise<string | null>;
  killPane(paneId: string): Promise<void>;
  listPanes(): Promise<PaneInfo[]>;
  requiresFocusForInput(): boolean;
}
