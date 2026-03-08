import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

const DEFAULT_EXCLUDES = new Set(['.git', 'node_modules', 'dist', 'coverage', '.ddudu']);
const REQUEST_TIMEOUT_MS = 2_500;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface LspServerSpec {
  id: string;
  label: string;
  command: string;
  args: string[];
  checkArgs: string[];
  languageId: string;
  extensions: string[];
  rootMarkers: string[];
}

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

interface LspLocation {
  uri: string;
  range: LspRange;
}

interface LspDocumentSymbolShape {
  name: string;
  detail?: string;
  kind?: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbolShape[];
}

export interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind?: number;
  filePath: string;
  range: LspRange;
  selectionRange: LspRange;
}

export interface LspResolvedLocation {
  filePath: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
}

export interface LspWorkspaceSymbol {
  name: string;
  detail?: string;
  kind?: number;
  filePath: string;
  range: LspRange;
}

export interface LspServerSummary {
  id: string;
  label: string;
  connected: boolean;
}

const SERVER_SPECS: LspServerSpec[] = [
  {
    id: 'typescript',
    label: 'TypeScript',
    command: resolve(PACKAGE_ROOT, 'node_modules/.bin/typescript-language-server'),
    args: ['--stdio'],
    checkArgs: ['--version'],
    languageId: 'typescript',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'],
    rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
  },
  {
    id: 'rust',
    label: 'Rust',
    command: 'rust-analyzer',
    args: [],
    checkArgs: ['--version'],
    languageId: 'rust',
    extensions: ['.rs'],
    rootMarkers: ['Cargo.toml', 'rust-project.json'],
  },
  {
    id: 'python',
    label: 'Python',
    command: 'pyright-langserver',
    args: ['--stdio'],
    checkArgs: ['--version'],
    languageId: 'python',
    extensions: ['.py'],
    rootMarkers: ['pyproject.toml', 'requirements.txt', 'setup.py'],
  },
  {
    id: 'go',
    label: 'Go',
    command: 'gopls',
    args: [],
    checkArgs: ['version'],
    languageId: 'go',
    extensions: ['.go'],
    rootMarkers: ['go.mod'],
  },
  {
    id: 'json',
    label: 'JSON',
    command: 'vscode-json-language-server',
    args: ['--stdio'],
    checkArgs: ['--version'],
    languageId: 'json',
    extensions: ['.json'],
    rootMarkers: [],
  },
];

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
};

const hasMatchingFiles = async (
  rootPath: string,
  extensions: Set<string>,
): Promise<boolean> => {
  const visit = async (dirPath: string): Promise<boolean> => {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (DEFAULT_EXCLUDES.has(entry.name)) {
        continue;
      }

      const fullPath = resolve(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (await visit(fullPath)) {
          return true;
        }
        continue;
      }

      if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
        return true;
      }
    }

    return false;
  };

  try {
    return await visit(rootPath);
  } catch {
    return false;
  }
};

const commandExists = async (spec: LspServerSpec): Promise<boolean> => {
  try {
    await execFileAsync(spec.command, spec.checkArgs, {
      encoding: 'utf8',
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
};

const uriToFilePath = (uri: string): string | null => {
  if (!uri.startsWith('file:')) {
    return null;
  }

  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
};

const normalizeLocation = (value: unknown): LspLocation | null => {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const uri = typeof record.uri === 'string' ? record.uri : null;
  const range = record.range as LspRange | undefined;
  if (!uri || !range?.start || !range.end) {
    return null;
  }

  return { uri, range };
};

const dedupeLocations = (locations: LspResolvedLocation[]): LspResolvedLocation[] => {
  const seen = new Set<string>();
  const deduped: LspResolvedLocation[] = [];
  for (const location of locations) {
    const key = `${location.filePath}:${location.line}:${location.character}:${location.endLine}:${location.endCharacter}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(location);
  }
  return deduped;
};

class JsonRpcClient {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly rootPath: string;
  private readonly spec: LspServerSpec;
  private readonly openedDocuments = new Map<string, { version: number; text: string }>();
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly ready: Promise<void>;
  private readonly shutdownPromise: Promise<void>;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private expectedLength: number | null = null;

  public constructor(rootPath: string, spec: LspServerSpec) {
    this.rootPath = rootPath;
    this.spec = spec;
    this.process = spawn(spec.command, spec.args, {
      cwd: rootPath,
      stdio: 'pipe',
      env: process.env,
    });

    this.process.stdout.on('data', (chunk: Buffer) => {
      this.onStdout(chunk);
    });
    this.process.stderr.on('data', () => {
      // Ignore noisy language-server stderr output.
    });

    this.shutdownPromise = new Promise<void>((resolve) => {
      this.process.once('exit', () => {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`${spec.label} language server exited unexpectedly.`));
        }
        this.pending.clear();
        resolve();
      });
    });

    this.ready = this.initialize();
  }

  public async documentSymbols(filePath: string): Promise<LspDocumentSymbol[]> {
    await this.ready;
    const uri = pathToFileURL(filePath).href;
    await this.syncDocument(filePath, uri);
    const response = await this.request('textDocument/documentSymbol', {
      textDocument: { uri },
    });
    return this.parseDocumentSymbols(response, filePath);
  }

  public async workspaceSymbols(query: string): Promise<LspWorkspaceSymbol[]> {
    await this.ready;
    const response = await this.request('workspace/symbol', { query });
    return this.parseWorkspaceSymbols(response);
  }

  public async references(filePath: string, position: LspPosition): Promise<LspResolvedLocation[]> {
    await this.ready;
    const uri = pathToFileURL(filePath).href;
    await this.syncDocument(filePath, uri);
    const response = await this.request('textDocument/references', {
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    });

    const locations = Array.isArray(response) ? response : [];
    return dedupeLocations(
      locations
        .map(normalizeLocation)
        .filter((value): value is LspLocation => value !== null)
        .map((location) => {
          const resolvedPath = uriToFilePath(location.uri);
          if (!resolvedPath) {
            return null;
          }

          return {
            filePath: resolvedPath,
            line: location.range.start.line,
            character: location.range.start.character,
            endLine: location.range.end.line,
            endCharacter: location.range.end.character,
          };
        })
        .filter((value): value is LspResolvedLocation => value !== null),
    );
  }

  public async definition(filePath: string, position: LspPosition): Promise<LspResolvedLocation[]> {
    await this.ready;
    const uri = pathToFileURL(filePath).href;
    await this.syncDocument(filePath, uri);
    const response = await this.request('textDocument/definition', {
      textDocument: { uri },
      position,
    });

    const locations = Array.isArray(response) ? response : response ? [response] : [];
    return dedupeLocations(
      locations
        .map(normalizeLocation)
        .filter((value): value is LspLocation => value !== null)
        .map((location) => {
          const resolvedPath = uriToFilePath(location.uri);
          if (!resolvedPath) {
            return null;
          }

          return {
            filePath: resolvedPath,
            line: location.range.start.line,
            character: location.range.start.character,
            endLine: location.range.end.line,
            endCharacter: location.range.end.character,
          };
        })
        .filter((value): value is LspResolvedLocation => value !== null),
    );
  }

  public async shutdown(): Promise<void> {
    try {
      await this.ready;
      await Promise.race([
        this.request('shutdown', {}),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
      ]);
      this.notify('exit', {});
    } catch {
      this.process.kill();
    }

    await Promise.race([
      this.shutdownPromise,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          this.process.kill();
          resolve();
        }, 500);
      }),
    ]);
  }

  private async initialize(): Promise<void> {
    await this.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(this.rootPath).href,
      capabilities: {
        workspace: {
          symbol: {},
        },
        textDocument: {
          definition: {},
          references: {},
          documentSymbol: {},
        },
      },
      workspaceFolders: [
        {
          uri: pathToFileURL(this.rootPath).href,
          name: this.rootPath.split('/').pop() ?? this.rootPath,
        },
      ],
    });
    this.notify('initialized', {});
  }

  private async syncDocument(filePath: string, uri: string): Promise<void> {
    const text = await readFile(filePath, 'utf8');
    const current = this.openedDocuments.get(uri);
    if (!current) {
      this.openedDocuments.set(uri, { version: 1, text });
      this.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: this.spec.languageId,
          version: 1,
          text,
        },
      });
      return;
    }

    if (current.text === text) {
      return;
    }

    const version = current.version + 1;
    this.openedDocuments.set(uri, { version, text });
    this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  private parseDocumentSymbols(response: unknown, filePath: string): LspDocumentSymbol[] {
    if (!Array.isArray(response)) {
      return [];
    }

    const flatten = (input: unknown): LspDocumentSymbol[] => {
      if (typeof input !== 'object' || input === null) {
        return [];
      }
      const record = input as Record<string, unknown>;
      const name = typeof record.name === 'string' ? record.name : null;
      const range = record.range as LspRange | undefined;
      const selectionRange = record.selectionRange as LspRange | undefined;
      if (!name || !range?.start || !range.end || !selectionRange?.start || !selectionRange.end) {
        return [];
      }

      const children = Array.isArray(record.children)
        ? record.children.flatMap((child) => flatten(child))
        : [];
      return [
        {
          name,
          detail: typeof record.detail === 'string' ? record.detail : undefined,
          kind: typeof record.kind === 'number' ? record.kind : undefined,
          filePath,
          range,
          selectionRange,
        },
        ...children,
      ];
    };

    return response.flatMap((symbol) => flatten(symbol));
  }

  private parseWorkspaceSymbols(response: unknown): LspWorkspaceSymbol[] {
    if (!Array.isArray(response)) {
      return [];
    }

    const results: LspWorkspaceSymbol[] = [];
    for (const item of response) {
      if (typeof item !== 'object' || item === null) {
        continue;
      }

      const record = item as Record<string, unknown>;
      const name = typeof record.name === 'string' ? record.name : null;
      const location = normalizeLocation(record.location);
      if (!name || !location) {
        continue;
      }

      const filePath = uriToFilePath(location.uri);
      if (!filePath) {
        continue;
      }

      results.push({
        name,
        detail: typeof record.detail === 'string' ? record.detail : undefined,
        kind: typeof record.kind === 'number' ? record.kind : undefined,
        filePath,
        range: location.range,
      });
    }

    return results;
  }

  private onStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      if (this.expectedLength === null) {
        const separatorIndex = this.buffer.indexOf('\r\n\r\n');
        if (separatorIndex < 0) {
          return;
        }
        const header = this.buffer.slice(0, separatorIndex).toString('utf8');
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) {
          this.buffer = this.buffer.slice(separatorIndex + 4);
          continue;
        }
        this.expectedLength = Number.parseInt(match[1] ?? '0', 10);
        this.buffer = this.buffer.slice(separatorIndex + 4);
      }

      if (this.expectedLength === null || this.buffer.length < this.expectedLength) {
        return;
      }

      const messageBuffer = this.buffer.slice(0, this.expectedLength);
      this.buffer = this.buffer.slice(this.expectedLength);
      this.expectedLength = null;

      try {
        const message = JSON.parse(messageBuffer.toString('utf8')) as Record<string, unknown>;
        this.handleMessage(message);
      } catch {
        // Ignore malformed server output.
      }
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    const id = typeof message.id === 'number' ? message.id : null;
    if (id === null) {
      return;
    }

    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(id);

    if (message.error && typeof message.error === 'object' && message.error !== null) {
      const errorRecord = message.error as Record<string, unknown>;
      const errorMessage = typeof errorRecord.message === 'string'
        ? errorRecord.message
        : `${this.spec.label} language server request failed.`;
      pending.reject(new Error(errorMessage));
      return;
    }

    pending.resolve(message.result);
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;

    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });

    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.spec.label} language server timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
    });

    this.writeMessage(payload);
    return promise;
  }

  private notify(method: string, params: unknown): void {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    });
    this.writeMessage(payload);
  }

  private writeMessage(payload: string): void {
    const header = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n`;
    this.process.stdin.write(header + payload);
  }
}

export class LspManager {
  private readonly rootCwd: string;
  private readonly availableSpecs = new Map<string, LspServerSpec>();
  private readonly clients = new Map<string, Promise<JsonRpcClient>>();

  public constructor(rootCwd: string = process.cwd()) {
    this.rootCwd = resolve(rootCwd);
  }

  public async refresh(rootPath: string = this.rootCwd): Promise<void> {
    const nextAvailable = new Map<string, LspServerSpec>();
    for (const spec of SERVER_SPECS) {
      const [hasCommand, hasFiles] = await Promise.all([
        commandExists(spec),
        hasMatchingFiles(rootPath, new Set(spec.extensions)),
      ]);
      if (hasCommand && hasFiles) {
        nextAvailable.set(spec.id, spec);
      }
    }
    this.availableSpecs.clear();
    for (const [id, spec] of nextAvailable.entries()) {
      this.availableSpecs.set(id, spec);
    }
  }

  public getServerState(): { available: LspServerSummary[]; connected: LspServerSummary[] } {
    const available = Array.from(this.availableSpecs.values()).map((spec) => ({
      id: spec.id,
      label: spec.label,
      connected: false,
    }));
    const connectedKeys = new Set(this.clients.keys());
    const connected = available.filter((server) =>
      Array.from(connectedKeys.values()).some((key) => key.startsWith(`${server.id}:`)),
    );
    return { available, connected };
  }

  public supportsFile(filePath: string): boolean {
    const spec = this.getSpecForFile(filePath);
    return Boolean(spec && this.availableSpecs.has(spec.id));
  }

  public async documentSymbols(filePath: string): Promise<LspDocumentSymbol[]> {
    const client = await this.getClientForFile(filePath);
    if (!client) {
      return [];
    }

    try {
      return await client.documentSymbols(filePath);
    } catch {
      return [];
    }
  }

  public async references(filePath: string, position: LspPosition): Promise<LspResolvedLocation[]> {
    const client = await this.getClientForFile(filePath);
    if (!client) {
      return [];
    }

    try {
      return await client.references(filePath, position);
    } catch {
      return [];
    }
  }

  public async definition(filePath: string, position: LspPosition): Promise<LspResolvedLocation[]> {
    const client = await this.getClientForFile(filePath);
    if (!client) {
      return [];
    }

    try {
      return await client.definition(filePath, position);
    } catch {
      return [];
    }
  }

  public async workspaceSymbols(query: string, filePath: string): Promise<LspWorkspaceSymbol[]> {
    const client = await this.getClientForFile(filePath);
    if (!client) {
      return [];
    }

    try {
      return await client.workspaceSymbols(query);
    } catch {
      return [];
    }
  }

  public async shutdown(): Promise<void> {
    const clients = Array.from(this.clients.values());
    this.clients.clear();
    await Promise.allSettled(clients.map(async (clientPromise) => {
      const client = await clientPromise;
      await client.shutdown();
    }));
  }

  private async getClientForFile(filePath: string): Promise<JsonRpcClient | null> {
    const spec = this.getSpecForFile(filePath);
    if (!spec || !this.availableSpecs.has(spec.id)) {
      return null;
    }

    const rootPath = await this.resolveProjectRoot(filePath, spec);
    const key = `${spec.id}:${rootPath}`;
    let clientPromise = this.clients.get(key);
    if (!clientPromise) {
      clientPromise = Promise.resolve(new JsonRpcClient(rootPath, spec));
      this.clients.set(key, clientPromise);
    }

    return clientPromise;
  }

  private getSpecForFile(filePath: string): LspServerSpec | null {
    const extension = extname(filePath).toLowerCase();
    return SERVER_SPECS.find((spec) => spec.extensions.includes(extension)) ?? null;
  }

  private async resolveProjectRoot(filePath: string, spec: LspServerSpec): Promise<string> {
    let cursor = dirname(resolve(filePath));
    const limit = this.rootCwd;
    while (cursor.startsWith(limit)) {
      for (const marker of spec.rootMarkers) {
        if (await exists(resolve(cursor, marker))) {
          return cursor;
        }
      }

      const parent = dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }

    return this.rootCwd;
  }
}
