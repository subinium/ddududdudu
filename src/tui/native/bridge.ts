import { createInterface } from 'node:readline';

import type { NamedMode } from '../../core/types.js';
import type { NativeBridgeCommand, NativeBridgeEvent } from './protocol.js';
import { NativeBridgeController } from './controller.js';

const BRIDGE_EVENT_PREFIX = '__DDUDU_BRIDGE__ ';

const writeEvent = (event: NativeBridgeEvent): void => {
  const encoded = Buffer.from(JSON.stringify(event), 'utf8').toString('base64');
  process.stdout.write(`${BRIDGE_EVENT_PREFIX}${encoded}\n`);
};

const redirectConsoleToStderr = (): void => {
  const writer = (...args: unknown[]): void => {
    const text = args
      .map((value) => {
        if (typeof value === 'string') {
          return value;
        }

        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })
      .join(' ');
    process.stderr.write(`${text}\n`);
  };

  console.log = writer;
  console.warn = writer;
  console.error = writer;
};

const isNamedMode = (value: string): value is NamedMode => {
  return value === 'jennie' || value === 'lisa' || value === 'rosé' || value === 'jisoo';
};

const parseCommand = (line: string): NativeBridgeCommand | null => {
  if (!line.trim()) {
    return null;
  }

  const parsed = JSON.parse(line) as { type?: unknown; [key: string]: unknown };
  if (typeof parsed.type !== 'string') {
    return null;
  }

  switch (parsed.type) {
    case 'submit':
      return typeof parsed.content === 'string' ? { type: 'submit', content: parsed.content } : null;
    case 'abort':
      return { type: 'abort' };
    case 'clear_messages':
      return { type: 'clear_messages' };
    case 'run_slash':
      return typeof parsed.command === 'string'
        ? { type: 'run_slash', command: parsed.command }
        : null;
    case 'toggle_fire':
      return { type: 'toggle_fire' };
    case 'append_system':
      return typeof parsed.content === 'string'
        ? { type: 'append_system', content: parsed.content }
        : null;
    case 'set_model':
      return typeof parsed.model === 'string' ? { type: 'set_model', model: parsed.model } : null;
    case 'answer_ask_user':
      return typeof parsed.answer === 'string'
        ? { type: 'answer_ask_user', answer: parsed.answer }
        : null;
    case 'cycle_mode':
      return parsed.direction === -1 ? { type: 'cycle_mode', direction: -1 } : { type: 'cycle_mode', direction: 1 };
    case 'set_mode':
      return typeof parsed.mode === 'string' && isNamedMode(parsed.mode)
        ? { type: 'set_mode', mode: parsed.mode }
        : null;
    default:
      return null;
  }
};

export const runNativeBridge = async (): Promise<void> => {
  redirectConsoleToStderr();

  const controller = new NativeBridgeController(writeEvent);
  await controller.boot();

  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on('line', (line: string) => {
    let command: NativeBridgeCommand | null = null;

    try {
      command = parseCommand(line);
    } catch (error: unknown) {
      console.error(
        '[ddudu bridge] ignored invalid command:',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    if (!command) {
      return;
    }

    switch (command.type) {
      case 'submit':
        void controller.submit(command.content);
        break;
      case 'abort':
        controller.abortCurrentRequest();
        break;
      case 'clear_messages':
        controller.clearMessages();
        break;
      case 'run_slash':
        void controller.runSlashCommand(command.command);
        break;
      case 'set_mode':
        controller.setMode(command.mode);
        break;
      case 'cycle_mode':
        controller.cycleMode(command.direction);
        break;
      case 'set_model':
        controller.setModel(command.model);
        break;
      case 'toggle_fire':
        controller.toggleFire();
        break;
      case 'answer_ask_user':
        controller.answerAskUser(command.answer);
        break;
      case 'append_system':
        controller.appendSystemMessage(command.content);
        break;
      default:
        break;
    }
  });

  rl.on('close', () => {
    controller.shutdown();
  });
};
