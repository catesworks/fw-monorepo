import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { tokens } from './tokens.js';

const css = readFileSync(path.join(import.meta.dirname, 'tokens.css'), 'utf8');

function parseCssVars(source: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const re = /--fw-(\w+)-(\w+):\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const [, group, key, rawValue] = match;
    vars[`${group}-${key}`] = rawValue;
  }
  return vars;
}

const cssVars = parseCssVars(css);

function normalizeFont(value: string): string {
  return value.trim().replace(/['"]/g, '').replace(/\s+/g, ' ');
}

describe('tokens.ts / tokens.css normalization contract', () => {
  it('colors match case-insensitively', () => {
    for (const [key, value] of Object.entries(tokens.color)) {
      const cssValue = cssVars[`color-${key}`];
      expect(cssValue, `missing --fw-color-${key}`).toBeDefined();
      expect(value.toLowerCase()).toBe(cssValue.trim().toLowerCase());
    }
  });

  it('fonts match after trimming/quote-stripping/whitespace-collapsing', () => {
    expect(cssVars['font-sans']).toBeDefined();
    expect(cssVars['font-mono']).toBeDefined();
    expect(normalizeFont(tokens.font.sans)).toBe(normalizeFont(cssVars['font-sans']));
    expect(normalizeFont(tokens.font.mono)).toBe(normalizeFont(cssVars['font-mono']));
  });

  it('spacing scale (indices 1..8) matches --fw-space-{i}', () => {
    for (let i = 1; i <= 8; i++) {
      const expected = `${tokens.space[i]}px`;
      const cssValue = cssVars[`space-${i}`];
      expect(cssValue, `missing --fw-space-${i}`).toBeDefined();
      expect(expected).toBe(cssValue.trim());
    }
  });

  it('radius values match exactly', () => {
    for (const [key, value] of Object.entries(tokens.radius)) {
      const cssValue = cssVars[`radius-${key}`];
      expect(cssValue, `missing --fw-radius-${key}`).toBeDefined();
      expect(value).toBe(cssValue.trim());
    }
  });
});
