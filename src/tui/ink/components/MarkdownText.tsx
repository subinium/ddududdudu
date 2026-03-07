import React from 'react';
import { createRequire } from 'node:module';
import { Text } from 'ink';
import { BP } from '../theme.js';

interface MarkdownTextProps {
  content: string;
  width?: number;
}

const require = createRequire(import.meta.url);

let MarkdownComponent: React.ComponentType<{ children: string; styles?: Record<string, unknown> }> | null = null;
let loadError = false;

const loadMarkdownComponent = (): React.ComponentType<{ children: string; styles?: Record<string, unknown> }> | null => {
  if (loadError) {
    return null;
  }

  if (MarkdownComponent) {
    return MarkdownComponent;
  }

  try {
    const mod = require('ink-markdown-es');
    MarkdownComponent = mod.default ?? mod.Markdown ?? null;
    return MarkdownComponent;
  } catch {
    loadError = true;
    return null;
  }
};

export const MarkdownText: React.FC<MarkdownTextProps> = ({ content, width }) => {
  const safeContent = content ?? '';

  if (!safeContent.trim()) {
    return <Text color={BP.white}>{safeContent}</Text>;
  }

  const Markdown = loadMarkdownComponent();

  if (Markdown) {
    try {
      const styles = {
        h1: { color: BP.pink, bold: true },
        h2: { color: BP.pink, bold: true },
        h3: { color: BP.pink, bold: true },
        h4: { color: BP.pink, bold: true },
        h5: { color: BP.pink, bold: true },
        h6: { color: BP.pink, bold: true },
        code: { backgroundColor: BP.darkGray, color: BP.white },
        codespan: { backgroundColor: BP.darkGray, color: BP.white },
        blockquote: { color: BP.pinkDim, italic: true },
        link: { color: BP.pink, underline: true },
        strong: { bold: true },
        em: { italic: true },
        text: { color: BP.white },
        paragraph: { color: BP.white },
        list: { color: BP.white },
        listitem: { color: BP.white },
        table: { color: BP.white },
      };

      return <Markdown styles={styles}>{safeContent}</Markdown>;
    } catch {
      return <Text color={BP.white}>{safeContent}</Text>;
    }
  }

  return <Text color={BP.white}>{safeContent}</Text>;
};
