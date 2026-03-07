import React from 'react';
import { Text } from 'ink';

interface GradientLineProps {
  width: number;
  fromColor?: string;
  toColor?: string;
  char?: string;
}

const hexToRgb = (hex: string): [number, number, number] => {
  const cleaned = hex.replace('#', '');
  return [
    Number.parseInt(cleaned.slice(0, 2), 16),
    Number.parseInt(cleaned.slice(2, 4), 16),
    Number.parseInt(cleaned.slice(4, 6), 16),
  ];
};

const rgbToHex = (r: number, g: number, b: number): string => {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
};

const lerp = (a: number, b: number, t: number): number => {
  return Math.round(a + (b - a) * t);
};

export const GradientLine: React.FC<GradientLineProps> = ({
  width,
  fromColor = '#f7a7bb',
  toColor = '#be788c',
  char = '─',
}) => {
  if (width <= 0) {
    return null;
  }

  if (width === 1) {
    return <Text color={fromColor}>{char}</Text>;
  }

  const [fr, fg, fb] = hexToRgb(fromColor);
  const [tr, tg, tb] = hexToRgb(toColor);

  const elements: React.ReactNode[] = [];
  for (let i = 0; i < width; i++) {
    const t = i / (width - 1);
    const color = rgbToHex(lerp(fr, tr, t), lerp(fg, tg, t), lerp(fb, tb, t));
    elements.push(
      <Text key={i} color={color}>
        {char}
      </Text>
    );
  }

  return <Text>{elements}</Text>;
};
