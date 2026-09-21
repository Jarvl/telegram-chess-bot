import type { ThemeParams } from './types';
import type { Tg } from './webapp';

/** Spec §6.7: Telegram's colours with a fixed palette per scheme when a key is missing. */
export const FALLBACK_THEME = {
  light: {
    bg: '#ffffff',
    text: '#000000',
    hint: '#707579',
    link: '#2481cc',
    button: '#2481cc',
    buttonText: '#ffffff',
    secondaryBg: '#f1f1f4',
    destructive: '#d14e4e',
  },
  dark: {
    bg: '#18222d',
    text: '#ffffff',
    hint: '#8b9aa8',
    link: '#6ab2f2',
    button: '#2ea6ff',
    buttonText: '#ffffff',
    secondaryBg: '#131b23',
    destructive: '#ef5b5b',
  },
} as const;

export function themeVariables(
  params: ThemeParams,
  scheme: 'light' | 'dark',
): Record<string, string> {
  const fallback = FALLBACK_THEME[scheme];
  return {
    '--bg': params.bg_color ?? fallback.bg,
    '--text': params.text_color ?? fallback.text,
    '--hint': params.hint_color ?? fallback.hint,
    '--link': params.link_color ?? fallback.link,
    '--button': params.button_color ?? fallback.button,
    '--button-text': params.button_text_color ?? fallback.buttonText,
    '--secondary-bg': params.secondary_bg_color ?? fallback.secondaryBg,
    '--destructive': params.destructive_text_color ?? fallback.destructive,
  };
}

/** Writes the theme and the stable viewport height as CSS custom properties on the root. */
export function applyTheme(tg: Tg, root: HTMLElement = document.documentElement): void {
  for (const [name, value] of Object.entries(themeVariables(tg.themeParams, tg.colorScheme))) {
    root.style.setProperty(name, value);
  }
  root.dataset.theme = tg.colorScheme;
  root.style.setProperty('--stable-height', `${tg.stableHeight}px`);
}
