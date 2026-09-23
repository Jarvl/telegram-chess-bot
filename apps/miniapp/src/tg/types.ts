/** The subset of the Telegram Mini Apps API this app uses (Bot API 6.0 – 8.0 surface). */
export type ThemeParams = Partial<
  Record<
    | 'bg_color'
    | 'text_color'
    | 'hint_color'
    | 'link_color'
    | 'button_color'
    | 'button_text_color'
    | 'secondary_bg_color'
    | 'header_bg_color'
    | 'accent_text_color'
    | 'section_bg_color'
    | 'subtitle_text_color'
    | 'destructive_text_color',
    string
  >
>;

export type TelegramButton = {
  readonly isVisible: boolean;
  setText(text: string): void;
  show(): void;
  hide(): void;
  onClick(callback: () => void): void;
  offClick(callback: () => void): void;
  showProgress(leaveActive?: boolean): void;
  hideProgress(): void;
  enable(): void;
  disable(): void;
  setParams?(params: { color?: string; text_color?: string }): void;
};

export type TelegramUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type TelegramWebApp = {
  initData: string;
  initDataUnsafe: { start_param?: string; user?: TelegramUser };
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  themeParams: ThemeParams;
  viewportHeight: number;
  viewportStableHeight: number;
  isExpanded: boolean;
  ready(): void;
  expand(): void;
  close(): void;
  isVersionAtLeast?(version: string): boolean;
  onEvent(event: string, callback: (...args: unknown[]) => void): void;
  offEvent(event: string, callback: (...args: unknown[]) => void): void;
  openLink(url: string, options?: { try_instant_view?: boolean }): void;
  openTelegramLink(url: string): void;
  BackButton: {
    readonly isVisible: boolean;
    show(): void;
    hide(): void;
    onClick(callback: () => void): void;
    offClick(callback: () => void): void;
  };
  MainButton: TelegramButton;
  SecondaryButton?: TelegramButton;
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
  disableVerticalSwipes?(): void;
  enableVerticalSwipes?(): void;
  requestWriteAccess?(callback?: (granted: boolean) => void): void;
  downloadFile?(
    request: { url: string; file_name: string },
    callback?: (accepted: boolean) => void,
  ): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  setBottomBarColor?(color: string): void;
};

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}
