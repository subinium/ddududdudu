const ENABLE_MOUSE_SEQUENCE = '\u001b[?1000h\u001b[?1006h\u001b[?1003h';
const DISABLE_MOUSE_SEQUENCE = '\u001b[?1000l\u001b[?1006l\u001b[?1003l';
const SGR_MOUSE_PATTERN = /\u001b\[<(\d+);(\d+);(\d+)([mM])/u;

const SHIFT_MASK = 4;
const CTRL_MASK = 16;
const MOTION_MASK = 32;
const WHEEL_MASK = 64;

export interface MouseEvent {
  type: 'click' | 'release' | 'wheel-up' | 'wheel-down' | 'move';
  button: number;
  col: number;
  row: number;
  shift: boolean;
  ctrl: boolean;
}

const decodeMouseType = (code: number, suffix: 'M' | 'm'): MouseEvent['type'] => {
  const wheelCode = code & (WHEEL_MASK | 1);
  if ((code & WHEEL_MASK) !== 0) {
    return wheelCode === WHEEL_MASK ? 'wheel-up' : 'wheel-down';
  }

  if ((code & MOTION_MASK) !== 0) {
    return 'move';
  }

  if (suffix === 'm') {
    return 'release';
  }

  return 'click';
};

const parseMouse = (value: string): MouseEvent | null => {
  const match = value.match(SGR_MOUSE_PATTERN);
  if (!match) {
    return null;
  }

  const rawCode = Number.parseInt(match[1], 10);
  const col = Number.parseInt(match[2], 10);
  const row = Number.parseInt(match[3], 10);
  const suffix = match[4] === 'm' ? 'm' : 'M';

  const button = rawCode & 0b11;
  const type = decodeMouseType(rawCode, suffix);

  return {
    type,
    button,
    col,
    row,
    shift: (rawCode & SHIFT_MASK) !== 0,
    ctrl: (rawCode & CTRL_MASK) !== 0,
  };
};

export const enableMouse = (): string => ENABLE_MOUSE_SEQUENCE;

export const disableMouse = (): string => DISABLE_MOUSE_SEQUENCE;

export class MouseTracker {
  public enable(): string {
    return enableMouse();
  }

  public disable(): string {
    return disableMouse();
  }

  public parse(data: Buffer | string): MouseEvent | null {
    const value = typeof data === 'string' ? data : data.toString('utf8');
    return parseMouse(value);
  }

  public isMouseEvent(data: Buffer | string): boolean {
    const value = typeof data === 'string' ? data : data.toString('utf8');
    return SGR_MOUSE_PATTERN.test(value);
  }
}
