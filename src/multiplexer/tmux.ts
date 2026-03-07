import { execFile } from 'node:child_process';

import type { Multiplexer, PaneInfo } from './interface.js';

const execTmux = (args: string[]): Promise<string> => {
  return new Promise<string>((resolve, reject) => {
    execFile('tmux', args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const message = stderr.trim() || error.message;
        reject(new Error(message));
        return;
      }

      resolve(stdout);
    });
  });
};

const parsePaneLine = (line: string): PaneInfo | null => {
  const tokens = line.trim().split(/\s+/u);
  if (tokens.length < 5) {
    return null;
  }

  const id = tokens[0];
  const heightToken = tokens[tokens.length - 1];
  const widthToken = tokens[tokens.length - 2];
  const activeToken = tokens[tokens.length - 3];
  const name = tokens.slice(1, tokens.length - 3).join(' ');
  const width = Number(widthToken);
  const height = Number(heightToken);

  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }

  return {
    id,
    name,
    active: activeToken === '1',
    width,
    height,
  };
};

export class TmuxMultiplexer implements Multiplexer {
  public readonly name = 'tmux';

  public async createWindow(params: { name: string; cwd: string }): Promise<string> {
    const stdout = await execTmux(['new-window', '-n', params.name, '-c', params.cwd, '-PF', '#{pane_id}']);
    return stdout.trim();
  }

  public async splitPane(targetId: string, direction: 'h' | 'v', cwd: string): Promise<string> {
    const flag = direction === 'h' ? '-h' : '-v';
    const stdout = await execTmux([
      'split-window',
      '-t',
      targetId,
      flag,
      '-c',
      cwd,
      '-PF',
      '#{pane_id}',
    ]);
    return stdout.trim();
  }

  public async sendKeys(paneId: string, command: string): Promise<void> {
    await execTmux(['send-keys', '-t', paneId, command, 'Enter']);
  }

  public async capturePane(paneId: string, lines?: number): Promise<string | null> {
    const args = ['capture-pane', '-t', paneId, '-p'];
    if (typeof lines === 'number' && Number.isFinite(lines) && lines > 0) {
      args.push('-S', `-${Math.floor(lines)}`);
    }

    const stdout = await execTmux(args);
    return stdout;
  }

  public async killPane(paneId: string): Promise<void> {
    await execTmux(['kill-pane', '-t', paneId]);
  }

  public async listPanes(): Promise<PaneInfo[]> {
    const stdout = await execTmux([
      'list-panes',
      '-F',
      '#{pane_id} #{pane_title} #{pane_active} #{pane_width} #{pane_height}',
    ]);

    return stdout
      .split(/\r?\n/u)
      .map((line: string) => parsePaneLine(line))
      .filter((pane: PaneInfo | null): pane is PaneInfo => pane !== null);
  }

  public requiresFocusForInput(): boolean {
    return false;
  }
}
