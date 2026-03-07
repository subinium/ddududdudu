import { EventEmitter } from 'node:events';

export interface Tab {
  id: string;
  name: string;
  sessionId: string;
  status: 'active' | 'idle' | 'working';
  lines: string[];
  agentId?: string;
}

interface TabManagerEvents {
  switch: [tab: Tab];
  close: [tab: Tab];
}

export class TabManager {
  private readonly emitter = new EventEmitter();
  private readonly maxTabs: number;
  private readonly tabs: Tab[] = [];
  private nextTabId = 1;
  private nextSessionId = 1;
  private activeTabId: string | null = null;

  public constructor(maxTabs = 8) {
    this.maxTabs = maxTabs;
  }

  public on<K extends keyof TabManagerEvents>(
    eventName: K,
    listener: (...args: TabManagerEvents[K]) => void,
  ): this {
    this.emitter.on(eventName, listener);
    return this;
  }

  public off<K extends keyof TabManagerEvents>(
    eventName: K,
    listener: (...args: TabManagerEvents[K]) => void,
  ): this {
    this.emitter.off(eventName, listener);
    return this;
  }

  public addTab(name: string): Tab {
    if (this.tabs.length >= this.maxTabs) {
      throw new Error(`Cannot open more than ${this.maxTabs} tabs`);
    }

    const tab: Tab = {
      id: `tab-${this.nextTabId++}`,
      name,
      sessionId: `sess-${this.nextSessionId++}`,
      status: 'idle',
      lines: [],
    };

    this.tabs.push(tab);
    this.switchTab(tab.id);
    return tab;
  }

  public closeTab(id: string): void {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) {
      return;
    }

    const [closedTab] = this.tabs.splice(index, 1);
    this.emitter.emit('close', closedTab);

    if (!closedTab || this.activeTabId !== id) {
      return;
    }

    if (this.tabs.length === 0) {
      this.activeTabId = null;
      return;
    }

    const nextIndex = Math.min(index, this.tabs.length - 1);
    const nextTab = this.tabs[nextIndex];
    if (nextTab) {
      this.switchTab(nextTab.id);
    }
  }

  public switchTab(id: string): void {
    const nextTab = this.tabs.find((tab) => tab.id === id);
    if (!nextTab) {
      return;
    }

    this.tabs.forEach((tab) => {
      if (tab.id === id) {
        if (tab.status !== 'working') {
          tab.status = 'active';
        }
      } else if (tab.status !== 'working') {
        tab.status = 'idle';
      }
    });

    this.activeTabId = id;
    this.emitter.emit('switch', nextTab);
  }

  public getActiveTab(): Tab | undefined {
    if (!this.activeTabId) {
      return undefined;
    }

    return this.tabs.find((tab) => tab.id === this.activeTabId);
  }

  public getTabs(): readonly Tab[] {
    return this.tabs;
  }
}
