import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { DduduConfig, DduduConfigOverride } from '../core/types.js';
import { loadHeartbeat, parseHeartbeat, type HeartbeatRule } from './heartbeat.js';
import { loadSoul } from './soul.js';

export interface OpenClawPayload {
  soul: string | null;
  user: string | null;
  heartbeat: string | null;
  heartbeatRules: HeartbeatRule[];
}

const defaultUserSearchPaths = (): string[] => {
  return [
    join(process.cwd(), '.ddudu', 'USER.md'),
    join(homedir(), '.ddudu', 'USER.md'),
    join(process.cwd(), 'USER.md'),
  ];
};

const loadUser = async (searchPaths?: string[]): Promise<string | null> => {
  const candidates = searchPaths && searchPaths.length > 0 ? searchPaths : defaultUserSearchPaths();

  for (const filePath of candidates) {
    try {
      const content = await readFile(filePath, 'utf8');
      if (content.trim().length > 0) {
        return content;
      }
    } catch {
      continue;
    }
  }

  return null;
};

type CompatConfigLike =
  | Pick<DduduConfig, 'openclaw'>
  | Pick<DduduConfigOverride, 'openclaw'>
  | { openclaw?: { enabled?: boolean } }
  | null
  | undefined;

export class OpenClawCompat {
  private cached: OpenClawPayload | null = null;

  public async loadAll(): Promise<OpenClawPayload> {
    const [soul, user, heartbeat] = await Promise.all([
      loadSoul(),
      loadUser(),
      loadHeartbeat(),
    ]);

    const payload: OpenClawPayload = {
      soul,
      user,
      heartbeat,
      heartbeatRules: heartbeat ? parseHeartbeat(heartbeat) : [],
    };

    this.cached = payload;
    return payload;
  }

  public getSystemPromptInjection(): string {
    if (!this.cached) {
      return '';
    }

    const sections: string[] = [];
    if (this.cached.soul) {
      sections.push(`## SOUL.md\n${this.cached.soul.trim()}`);
    }

    if (this.cached.user) {
      sections.push(`## USER.md\n${this.cached.user.trim()}`);
    }

    if (this.cached.heartbeat) {
      sections.push(`## HEARTBEAT.md\n${this.cached.heartbeat.trim()}`);
    }

    return sections.join('\n\n');
  }

  public isEnabled(config: CompatConfigLike): boolean {
    return config?.openclaw?.enabled === true;
  }
}
