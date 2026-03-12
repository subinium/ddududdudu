import { execFile } from 'node:child_process';

const KEYRING_GET_TIMEOUT_MS = 1500;

interface ExecResult {
  stdout: string;
  stderr: string;
}

const runCommand = (command: string, args: string[], timeoutMs: number, stdin?: string): Promise<ExecResult> => {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });

    if (stdin !== undefined && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
};

export class KeyringStore {
  private availabilityChecked = false;

  private keyringAvailable = false;

  private getToolName(): 'security' | 'secret-tool' | null {
    if (process.platform === 'darwin') {
      return 'security';
    }

    if (process.platform === 'linux') {
      return 'secret-tool';
    }

    return null;
  }

  private async checkAvailability(): Promise<boolean> {
    if (this.availabilityChecked) {
      return this.keyringAvailable;
    }

    this.availabilityChecked = true;
    const toolName = this.getToolName();
    if (!toolName) {
      this.keyringAvailable = false;
      return false;
    }

    try {
      await runCommand('command', ['-v', toolName], KEYRING_GET_TIMEOUT_MS);
      this.keyringAvailable = true;
      return true;
    } catch {
      this.keyringAvailable = false;
      return false;
    }
  }

  public async get(service: string, account: string): Promise<string | null> {
    const available = await this.checkAvailability();
    if (!available) {
      return null;
    }

    try {
      let result: ExecResult;
      if (process.platform === 'darwin') {
        result = await runCommand(
          'security',
          ['find-generic-password', '-s', service, '-a', account, '-w'],
          KEYRING_GET_TIMEOUT_MS,
        );
      } else {
        result = await runCommand(
          'secret-tool',
          ['lookup', 'service', service, 'account', account],
          KEYRING_GET_TIMEOUT_MS,
        );
      }

      const token = result.stdout.trim();
      return token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }

  public async set(service: string, account: string, password: string): Promise<void> {
    const available = await this.checkAvailability();
    if (!available) {
      return;
    }

    if (process.platform === 'darwin') {
      await runCommand(
        'security',
        ['add-generic-password', '-s', service, '-a', account, '-w', password, '-U'],
        KEYRING_GET_TIMEOUT_MS,
      );
      return;
    }

    const label = `${service} (${account})`;
    await runCommand(
      'secret-tool',
      ['store', `--label=${label}`, 'service', service, 'account', account],
      KEYRING_GET_TIMEOUT_MS,
      password,
    );
  }

  public async delete(service: string, account: string): Promise<void> {
    const available = await this.checkAvailability();
    if (!available) {
      return;
    }

    if (process.platform === 'darwin') {
      await runCommand('security', ['delete-generic-password', '-s', service, '-a', account], KEYRING_GET_TIMEOUT_MS);
    } else {
      await runCommand('secret-tool', ['clear', 'service', service, 'account', account], KEYRING_GET_TIMEOUT_MS);
    }
  }
}
