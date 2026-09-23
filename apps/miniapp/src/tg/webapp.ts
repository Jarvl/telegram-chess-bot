import type { TelegramButton, TelegramWebApp, ThemeParams } from './types';

export type Feature =
  'haptics' | 'writeAccess' | 'verticalSwipes' | 'secondaryButton' | 'downloadFile';

/** Spec §6.6: the first Bot API version that has each capability. */
export const FEATURE_MIN_VERSION: Record<Feature, string> = {
  haptics: '6.1',
  writeAccess: '6.9',
  verticalSwipes: '7.7',
  secondaryButton: '7.10',
  downloadFile: '8.0',
};

export function versionAtLeast(version: string, minimum: string): boolean {
  const a = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = minimum.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export type HapticImpact = 'light' | 'medium' | 'heavy';
export type HapticNotification = 'success' | 'warning' | 'error';

export type ButtonSpec = {
  text: string;
  onClick: () => void;
  /** Shows the spinner and disables the button while true. */
  progress?: boolean;
  enabled?: boolean;
};

export interface Tg {
  /** False in a plain browser: every capability is off and buttons are rendered in-page. */
  readonly available: boolean;
  readonly version: string;
  readonly platform: string;
  readonly initData: string;
  readonly startParam: string | null;
  readonly colorScheme: 'light' | 'dark';
  readonly themeParams: ThemeParams;
  readonly stableHeight: number;
  supports(feature: Feature): boolean;
  ready(): void;
  expand(): void;
  close(): void;
  /** True when the client supports it and it was called. */
  disableVerticalSwipes(): boolean;
  haptic(kind: HapticImpact): void;
  hapticNotify(kind: HapticNotification): void;
  /** False when the client has no such button; the caller renders one in the page. */
  setMainButton(spec: ButtonSpec | null): boolean;
  setSecondaryButton(spec: ButtonSpec | null): boolean;
  setBackButton(visible: boolean, onClick: () => void): void;
  /** null when the client cannot ask (below 6.9). */
  requestWriteAccess(): Promise<boolean | null>;
  openLink(url: string): void;
  /** False when the client cannot download (below 8.0); the caller opens the link instead. */
  downloadFile(url: string, fileName: string): boolean;
  onViewportChanged(callback: (stableHeight: number) => void): () => void;
  onThemeChanged(callback: () => void): () => void;
}

class ButtonBinding {
  private handler: (() => void) | null = null;

  constructor(private readonly button: TelegramButton | undefined) {}

  set(spec: ButtonSpec | null): boolean {
    const { button } = this;
    if (!button) return false;
    if (this.handler) button.offClick(this.handler);
    this.handler = null;
    if (!spec) {
      button.hide();
      return true;
    }
    this.handler = spec.onClick;
    button.setText(spec.text);
    button.onClick(spec.onClick);
    if (spec.enabled === false) button.disable();
    else button.enable();
    if (spec.progress) button.showProgress(false);
    else button.hideProgress();
    button.show();
    return true;
  }
}

function nullTg(): Tg {
  return {
    available: false,
    version: '0.0',
    platform: 'unknown',
    initData: '',
    startParam: null,
    colorScheme:
      typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light',
    themeParams: {},
    stableHeight: typeof window === 'undefined' ? 0 : window.innerHeight,
    supports: () => false,
    ready: () => undefined,
    expand: () => undefined,
    close: () => undefined,
    disableVerticalSwipes: () => false,
    haptic: () => undefined,
    hapticNotify: () => undefined,
    setMainButton: () => false,
    setSecondaryButton: () => false,
    setBackButton: () => undefined,
    requestWriteAccess: () => Promise.resolve(null),
    openLink: (url) => {
      window.open(url, '_blank', 'noopener');
    },
    downloadFile: () => false,
    onViewportChanged: () => () => undefined,
    onThemeChanged: () => () => undefined,
  };
}

/** Wraps the real `window.Telegram.WebApp`; without one (a plain browser) every capability is off. */
export function createTg(
  raw: TelegramWebApp | null | undefined = typeof window === 'undefined'
    ? null
    : window.Telegram?.WebApp,
): Tg {
  if (!raw) return nullTg();
  const supports = (feature: Feature): boolean =>
    versionAtLeast(raw.version, FEATURE_MIN_VERSION[feature]);
  const main = new ButtonBinding(raw.MainButton);
  const secondary = new ButtonBinding(
    supports('secondaryButton') ? raw.SecondaryButton : undefined,
  );
  let backHandler: (() => void) | null = null;
  return {
    available: true,
    get version() {
      return raw.version;
    },
    get platform() {
      return raw.platform;
    },
    get initData() {
      return raw.initData;
    },
    get startParam() {
      return raw.initDataUnsafe?.start_param ?? null;
    },
    get colorScheme() {
      return raw.colorScheme === 'dark' ? 'dark' : 'light';
    },
    get themeParams() {
      return raw.themeParams ?? {};
    },
    get stableHeight() {
      return raw.viewportStableHeight || window.innerHeight;
    },
    supports,
    ready: () => raw.ready(),
    expand: () => raw.expand(),
    close: () => raw.close(),
    disableVerticalSwipes() {
      if (!supports('verticalSwipes') || !raw.disableVerticalSwipes) return false;
      raw.disableVerticalSwipes();
      return true;
    },
    haptic(kind) {
      if (supports('haptics')) raw.HapticFeedback?.impactOccurred(kind);
    },
    hapticNotify(kind) {
      if (supports('haptics')) raw.HapticFeedback?.notificationOccurred(kind);
    },
    setMainButton: (spec) => main.set(spec),
    setSecondaryButton: (spec) => secondary.set(spec),
    setBackButton(visible, onClick) {
      if (backHandler) raw.BackButton.offClick(backHandler);
      backHandler = onClick;
      raw.BackButton.onClick(onClick);
      if (visible) raw.BackButton.show();
      else raw.BackButton.hide();
    },
    requestWriteAccess() {
      if (!supports('writeAccess') || !raw.requestWriteAccess) return Promise.resolve(null);
      return new Promise((resolve) => raw.requestWriteAccess!((granted) => resolve(granted)));
    },
    openLink: (url) => raw.openLink(url),
    downloadFile(url, fileName) {
      if (!supports('downloadFile') || !raw.downloadFile) return false;
      raw.downloadFile({ url, file_name: fileName });
      return true;
    },
    onViewportChanged(callback) {
      const handler = (): void => callback(raw.viewportStableHeight || window.innerHeight);
      raw.onEvent('viewportChanged', handler);
      return () => raw.offEvent('viewportChanged', handler);
    },
    onThemeChanged(callback) {
      raw.onEvent('themeChanged', callback);
      return () => raw.offEvent('themeChanged', callback);
    },
  };
}
