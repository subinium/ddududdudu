import { exec } from 'node:child_process';

const KEYRING_GET_TIMEOUT_MS = 3000;

const shellQuote = (value: string): string => {
  return `'${value.replace(/'/g, `'\\''`)}'`;
};

interface ExecResult {
  stdout: string;
  stderr: string;
}

const runExec = (
  command: string,
  timeoutMs: number,
  stdin?: string,
): Promise<ExecResult> => {
  return new Promise((resolve, reject) => {
    const child = exec(command, { timeout: timeoutMs }, (error, stdout, stderr) => {
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
      await runExec(`command -v ${toolName}`, KEYRING_GET_TIMEOUT_MS);
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
      let command = '';
      if (process.platform === 'darwin') {
        command = `security find-generic-password -s ${shellQuote(service)} -a ${shellQuote(account)} -w`;
      } else {
        command = `secret-tool lookup service ${shellQuote(service)} account ${shellQuote(account)}`;
      }

      const { stdout } = await runExec(command, KEYRING_GET_TIMEOUT_MS);
      const token = stdout.trim();
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
      const command = `security add-generic-password -s ${shellQuote(service)} -a ${shellQuote(account)} -w ${shellQuote(password)} -U`;
      await runExec(command, KEYRING_GET_TIMEOUT_MS);
      return;
    }

    const label = `${service} (${account})`;
    const command = `secret-tool store --label=${shellQuote(label)} service ${shellQuote(service)} account ${shellQuote(account)}`;
    await runExec(command, KEYRING_GET_TIMEOUT_MS, password);
  }

  public async delete(service: string, account: string): Promise<void> {
    const available = await this.checkAvailability();
    if (!available) {
      return;
    }

    const command =
      process.platform === 'darwin'
        ? `security delete-generic-password -s ${shellQuote(service)} -a ${shellQuote(account)}`
        : `secret-tool clear service ${shellQuote(service)} account ${shellQuote(account)}`;

    await runExec(command, KEYRING_GET_TIMEOUT_MS);
  }
}
