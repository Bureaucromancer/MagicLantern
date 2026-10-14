// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The palette's own rules. ESLint keeps Tailwind scales out of components but
 * cannot read CSS, so these claims about index.css would otherwise be nobody's
 * job. The one that earns its keep is the last: the dark theme is written
 * twice, and a token edited in one copy only is a single wrong colour for half
 * the people who see it.
 */

const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Comments stripped: the file's own explanation names `@theme inline` to forbid it. */
const CSS = withoutComments(
  readFileSync(fileURLToPath(new URL('./index.css', import.meta.url)), 'utf8'),
);

/** The custom properties declared in a block, as name → value. */
function tokensIn(source: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of source.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    found.set(match[1]!, match[2]!.trim());
  }
  return found;
}

/** The body of the brace-balanced block opened after `marker`. */
function blockAfter(marker: string): string {
  const start = CSS.indexOf(marker);
  if (start < 0) throw new Error(`index.css has no ${marker}`);
  const open = CSS.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < CSS.length; i += 1) {
    if (CSS[i] === '{') depth += 1;
    if (CSS[i] === '}') {
      depth -= 1;
      if (depth === 0) return CSS.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced braces in index.css');
}

const colours = (tokens: Map<string, string>) =>
  new Map([...tokens].filter(([name]) => name.startsWith('--color-')));

const light = tokensIn(blockAfter('@theme'));
const darkByAttribute = tokensIn(blockAfter(":root[data-theme='dark']"));
const darkByPreference = tokensIn(blockAfter('@media (prefers-color-scheme: dark)'));

describe('the theme', () => {
  it('uses plain @theme, so tokens stay variables a second theme can redefine', () => {
    expect(CSS).not.toMatch(/@theme\s+inline/);
  });

  it('states the light palette by aliasing Tailwind rather than re-typing it', () => {
    const literals = [...colours(light)].filter(
      ([, value]) => !value.startsWith('var(--color-') && !value.startsWith('color-mix('),
    );
    expect(colours(light).size).toBeGreaterThan(10);
    expect(literals).toEqual([]);
  });

  it('gives every light colour a dark counterpart', () => {
    const unpaired = [...colours(light).keys()].filter((name) => !darkByAttribute.has(name));
    expect(unpaired).toEqual([]);
  });

  it('keeps the two copies of the dark theme identical', () => {
    expect(Object.fromEntries(colours(darkByPreference))).toEqual(
      Object.fromEntries(colours(darkByAttribute)),
    );
  });

  it('lets an explicit light choice beat a dark system preference', () => {
    expect(CSS).toMatch(
      /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)/,
    );
  });

  it('declares a colour scheme for each theme, so form chrome follows it', () => {
    expect(blockAfter(':root {')).toMatch(/color-scheme:\s*light/);
    expect(blockAfter(":root[data-theme='dark']")).toMatch(/color-scheme:\s*dark/);
    expect(blockAfter('@media (prefers-color-scheme: dark)')).toMatch(/color-scheme:\s*dark/);
  });

  it('paints the body explicitly rather than leaving it to the browser', () => {
    const body = blockAfter('\nbody {');
    expect(body).toMatch(/background-color:\s*var\(--color-canvas\)/);
    expect(body).toMatch(/color:\s*var\(--color-ink\)/);
    expect(body).toMatch(/font-family:\s*var\(--font-ui\)/);
  });

  it('draws text in a system face with a generic fallback, and downloads none', () => {
    const families = (light.get('--font-ui') ?? '').split(',').map((family) => family.trim());
    expect(families).toContain('sans-serif');
    expect(CSS).not.toMatch(/@font-face/);
  });
});

/** Tailwind's palette, which every token aliases: the stylesheet the build imports. */
const TAILWIND = tokensIn(
  withoutComments(
    readFileSync(createRequire(import.meta.url).resolve('tailwindcss/theme.css'), 'utf8'),
  ),
);

/** A token's colour in a theme, followed through its alias to Tailwind's value. */
function colourOf(token: string, theme: Map<string, string>): string {
  let value = theme.get(`--color-${token}`) ?? light.get(`--color-${token}`);
  for (let alias = /^var\((--color-[a-z0-9-]+)\)$/.exec(value ?? ''); alias !== null;) {
    value = TAILWIND.get(alias[1]!);
    alias = /^var\((--color-[a-z0-9-]+)\)$/.exec(value ?? '');
  }
  if (value === undefined) throw new Error(`index.css gives --color-${token} no colour`);
  return value;
}

/** Linear-light sRGB channels of `#rgb`, `#rrggbb` or `oklch(L% C H)`, before clipping. */
function linearSrgb(colour: string): [number, number, number] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour);
  if (hex !== null) {
    // `#abc` is `#aabbcc`.
    const six = hex[1]!.length === 3 ? hex[1]!.replace(/./g, '$&$&') : hex[1]!;
    const [r, g, b] = six.match(/../g)!.map((pair) => {
      const encoded = parseInt(pair, 16) / 255;
      return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
    });
    return [r!, g!, b!];
  }
  const oklch = /^oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)$/.exec(colour);
  if (oklch === null) throw new Error(`cannot measure ${colour}`);
  // OKLCH to OKLab to LMS to linear sRGB (Björn Ottosson's matrices, as CSS Color 4 uses).
  const lightness = Number(oklch[1]) / 100;
  const hue = (Number(oklch[3]) * Math.PI) / 180;
  const a = Number(oklch[2]) * Math.cos(hue);
  const b = Number(oklch[2]) * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** WCAG relative luminance, clipped to sRGB the way the browser draws an out-of-gamut colour. */
function luminance(colour: string): number {
  const [r, g, b] = linearSrgb(colour).map((channel) => Math.min(1, Math.max(0, channel)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(text: string, fill: string): number {
  const [lighter, darker] = [luminance(text), luminance(fill)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

/** WCAG AA for body text. */
const CONTRAST_FLOOR = 4.5;

/**
 * Every text-on-fill pairing the components draw, as tokens. index.css and
 * Button.tsx promise each keeps to the floor in every theme, disabled states
 * included (that is why they use tokens rather than opacity). A component
 * that pairs two tokens anew adds the pair here.
 */
const PAIRS: readonly (readonly [text: string, fill: string, where: string])[] = [
  ['ink', 'canvas', 'page text'],
  ['ink', 'surface', 'the header, a panel'],
  ['ink-muted', 'surface', 'the library name in the header'],
  ['ink-muted', 'surface-sunken', 'a neutral alert'],
  ['ink-muted', 'surface-muted', 'a disabled text field, a hovered secondary button'],
  ['ink-subtle', 'canvas', 'a note on the page'],
  ['ink-subtle', 'surface', 'a note in a panel'],
  ['ink-faint', 'canvas', 'the footer, a disabled button on the page'],
  ['ink-faint', 'surface', 'a placeholder, a disabled button in the header'],
  ['accent', 'canvas', 'a link'],
  ['accent-hover', 'canvas', 'a hovered link'],
  ['accent', 'danger-surface', 'a link in an error'],
  ['accent-hover', 'danger-surface', 'a hovered link in an error'],
  ['on-accent', 'accent', 'a primary button'],
  ['on-accent', 'accent-hover', 'a hovered primary button'],
  ['on-accent-muted', 'accent-muted', 'a disabled primary button'],
  ['danger-ink', 'danger-surface', 'an error'],
  ['danger-ink', 'surface', 'a sign-out failure in the header'],
  ['warn-ink', 'warn-surface', 'a warning'],
  ['badge-ink', 'badge-surface', 'a library status'],
];

describe('the palette’s contrast', () => {
  it('measures as WCAG does', () => {
    expect(contrast('#fff', '#000')).toBeCloseTo(21, 5);
    expect(contrast('#777', '#fff')).toBeCloseTo(4.48, 2);
    // sRGB red, written in OKLCH: the conversion lands where hex does.
    expect(contrast('oklch(62.8% 0.2577 29.23)', '#000')).toBeCloseTo(contrast('#f00', '#000'), 2);
  });

  it.each([
    ['light', light],
    ['dark (data-theme)', darkByAttribute],
    ['dark (system preference)', darkByPreference],
  ])('keeps every pairing the components draw at 4.5:1 or more in the %s theme', (_, theme) => {
    const below = PAIRS.map(([text, fill, where]) => ({
      pair: `${text} on ${fill} (${where})`,
      ratio: contrast(colourOf(text, theme), colourOf(fill, theme)),
    }))
      .filter(({ ratio }) => ratio < CONTRAST_FLOOR)
      .map(({ pair, ratio }) => `${pair}: ${ratio.toFixed(2)}:1`);
    expect(below).toEqual([]);
  });
});
