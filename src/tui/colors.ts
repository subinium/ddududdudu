// BLACKPINK brand pink — true color ANSI (24-bit)
// Primary pink: #f7a7bb — RGB(247, 167, 187)

export const PINK = '\x1b[38;2;247;167;187m';
export const PINK_BG = '\x1b[48;2;247;167;187m';
export const PINK_LIGHT = '\x1b[38;2;252;210;222m';
export const PINK_DIM = '\x1b[38;2;190;120;140m';

export const WHITE = '\x1b[97m';
export const WHITE_BRIGHT = '\x1b[1;97m';
export const DIM = '\x1b[2m';
export const BOLD = '\x1b[1m';
export const ITALIC = '\x1b[3m';
export const RED = '\x1b[38;2;255;80;80m';
export const GREEN = '\x1b[38;2;80;220;120m';
export const YELLOW = '\x1b[38;2;255;200;60m';
export const GRAY = '\x1b[38;2;100;100;100m';
export const RESET = '\x1b[0m';

export const PANEL_BG = '\x1b[48;2;0;0;0m';
export const PANEL_HEADER_BG = '\x1b[48;2;18;18;18m';
export const PANEL_DIVIDER = '\x1b[38;2;247;167;187m\x1b[48;2;247;167;187m█\x1b[0m';
export const PANEL_DIVIDER_DIM = '\x1b[38;2;120;80;100m▐\x1b[0m';

export const MAIN_BG = '\x1b[48;2;0;0;0m';

// ─── Box-drawing frame characters ───
export const BOX_TL = '┌';
export const BOX_TR = '┐';
export const BOX_BL = '└';
export const BOX_BR = '┘';
export const BOX_H = '─';
export const BOX_V = '│';
export const BOX_VR = '├';
export const BOX_VL = '┤';
export const BOX_HD = '┬';
export const BOX_HU = '┴';

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ─── BLACKPINK lyrics spinner phrases ───
export const BP_LYRICS: string[] = [
  'Playing with fire...',
  'How you like that...',
  'Kill this love...',
  'Pretty savage...',
  'BLACKPINK in your area...',
  'Shut it down...',
  'Taste that pink venom...',
  'Hit you with that DDU-DU...',
  'Kick in the door...',
  'Light up the sky...',
  'We are the lovesick girls...',
  'Born to be alone...',
  'Make \'em whistle...',
  'We ride or die...',
  'So hot, I need a fan...',
  'Pedal to the metal...',
  'Think twice...',
  'Look at me, look at me now...',
  'Not a comeback, never left...',
  'Now burn, baby, burn...',
];

// ─── Box-drawing characters for TUI borders ───

/** Vertical bar for assistant response left border */
export const BAR = '┃';
/** Horizontal separator line character */
export const H_LINE = '─';
/** Dot for system/info messages */
export const DOT = '●';

// ─── ANSI utilities ───

/** Strip all ANSI escape sequences from a string */
export const stripAnsi = (str: string): string =>
  str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

/** Visible character length (ignoring ANSI escape codes, respecting fullwidth) */
export const visibleLength = (str: string): number =>
  charWidth(stripAnsi(str));

/** Terminal column width of a string (fullwidth chars = 2 cols) */
export const charWidth = (str: string): number => {
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0) ?? 0;
    w += isFullwidth(cp) ? 2 : 1;
  }
  return w;
};

const isFullwidth = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115F) ||
  (cp >= 0x2E80 && cp <= 0x303E) ||
  (cp >= 0x3040 && cp <= 0x33BF) ||
  (cp >= 0x3400 && cp <= 0x4DBF) ||
  (cp >= 0x4E00 && cp <= 0xA4CF) ||
  (cp >= 0xAC00 && cp <= 0xD7AF) ||
  (cp >= 0xF900 && cp <= 0xFAFF) ||
  (cp >= 0xFE30 && cp <= 0xFE4F) ||
  (cp >= 0xFF01 && cp <= 0xFF60) ||
  (cp >= 0xFFE0 && cp <= 0xFFE6) ||
  (cp >= 0x20000 && cp <= 0x2FA1F);

/** Create a horizontal separator line of given width */
export const separator = (width: number): string =>
  `${GRAY}${H_LINE.repeat(Math.max(0, width))}${RESET}`;

/**
 * Join two rendered strings side-by-side, ANSI-safe.
 * Pads `left` to exactly `leftWidth` visible columns, resets ANSI state,
 * then appends `right`. Prevents ANSI bleed between panels.
 */
export const joinHorizontal = (left: string, right: string, leftWidth: number): string => {
  const vis = visibleLength(left);
  const pad = Math.max(0, leftWidth - vis);
  return `${left}${RESET}${' '.repeat(pad)}${right}`;
};

// ─── Message formatting helpers ───

/** Format a user prompt line: ❯ text */
export const fmtUser = (text: string): string =>
  `${PINK}❯${RESET} ${WHITE_BRIGHT}${text}${RESET}`;

/** Format an assistant response line with left border: ┃ text */
export const fmtAssistant = (text: string): string =>
  `  ${PINK}${BAR}${RESET} ${text}`;

/** Format an empty assistant border line */
export const fmtAssistantEmpty = (): string =>
  `  ${PINK}${BAR}${RESET}`;

/** Format the thinking spinner inside assistant block: ┃ ⠋ Thinking... */
export const fmtThinking = (frame: string): string =>
  `  ${PINK}${BAR}${RESET} ${DIM}${frame} Thinking...${RESET}`;

/** Format a system/info message: ● text */
export const fmtSystem = (text: string): string =>
  `  ${PINK_DIM}${DOT}${RESET} ${DIM}${text}${RESET}`;

/** Format an error message: ✗ text */
export const fmtError = (text: string): string =>
  `  ${RED}✗${RESET} ${RED}${text}${RESET}`;

/** Format a success message: ✓ text */
export const fmtSuccess = (text: string): string =>
  `  ${GREEN}✓${RESET} ${text}`;

/** TTY-safe color helpers for non-TUI output (--help, etc.) */
export const tty = (isTTY: boolean): {
  p: string; d: string; r: string; pl: string;
} => ({
  p: isTTY ? PINK : '',
  pl: isTTY ? PINK_LIGHT : '',
  d: isTTY ? DIM : '',
  r: isTTY ? RESET : '',
});
