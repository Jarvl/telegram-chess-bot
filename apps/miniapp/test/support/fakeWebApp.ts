/**
 * A fake `window.Telegram.WebApp` for unit tests and for Playwright (`page.addInitScript`).
 * The function must stay self-contained: Playwright serialises its source into the page.
 */
export type FakeWebAppOptions = {
  version: string;
  initData: string;
  startParam?: string;
  colorScheme?: 'light' | 'dark';
  themeParams?: Record<string, string>;
  stableHeight?: number;
  platform?: string;
  /** What `requestWriteAccess` answers; undefined means the client has no such method. */
  writeAccess?: boolean;
};

export type FakeButton = {
  text: string;
  visible: boolean;
  progress: boolean;
  enabled: boolean;
  color?: string;
  textColor?: string;
};

export type FakeWebAppRecord = {
  calls: string[];
  mainButton: FakeButton;
  secondaryButton: FakeButton | null;
  backButton: { visible: boolean };
  haptics: string[];
  links: string[];
  downloads: { url: string; file_name: string }[];
  closed: boolean;
  chrome: { header?: string; background?: string; bottomBar?: string };
  popups: {
    title?: string;
    message: string;
    buttons: { id?: string; type?: string; text?: string }[];
  }[];
  answerPopup(id: string): void;
  closingConfirmation: boolean;
  settingsButton: { visible: boolean } | null;
  clickSettings(): void;
  clickMain(): void;
  clickSecondary(): void;
  clickBack(): void;
  emit(event: string, ...args: unknown[]): void;
  setStableHeight(height: number): void;
};

declare global {
  interface Window {
    __tg?: FakeWebAppRecord;
  }
}

export function installFakeWebApp(options: FakeWebAppOptions): void {
  const atLeast = (version: string, minimum: string): boolean => {
    const a = version.split('.').map((p) => Number.parseInt(p, 10) || 0);
    const b = minimum.split('.').map((p) => Number.parseInt(p, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const x = a[i] ?? 0;
      const y = b[i] ?? 0;
      if (x !== y) return x > y;
    }
    return true;
  };
  let pendingPopup: ((id: string) => void) | null = null;
  const record: FakeWebAppRecord = {
    calls: [],
    mainButton: { text: '', visible: false, progress: false, enabled: true },
    secondaryButton: atLeast(options.version, '7.10')
      ? { text: '', visible: false, progress: false, enabled: true }
      : null,
    backButton: { visible: false },
    haptics: [],
    links: [],
    downloads: [],
    closed: false,
    chrome: {},
    popups: [],
    closingConfirmation: false,
    settingsButton: atLeast(options.version, '7.0') ? { visible: false } : null,
    answerPopup: (id) => {
      const answer = pendingPopup;
      pendingPopup = null;
      answer?.(id);
    },
    clickSettings: () => {
      for (const cb of [...handlers.settings]) cb();
    },
    clickMain: () => {
      for (const cb of [...handlers.main]) cb();
    },
    clickSecondary: () => {
      for (const cb of [...handlers.secondary]) cb();
    },
    clickBack: () => {
      for (const cb of [...handlers.back]) cb();
    },
    emit: (event, ...args) => {
      for (const cb of [...(listeners[event] ?? [])]) cb(...args);
    },
    setStableHeight: (height) => {
      webApp.viewportStableHeight = height;
      webApp.viewportHeight = height;
      record.emit('viewportChanged', { isStateStable: true });
    },
  };
  const handlers = {
    main: [] as (() => void)[],
    secondary: [] as (() => void)[],
    back: [] as (() => void)[],
    settings: [] as (() => void)[],
  };
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const button = (state: FakeButton, list: (() => void)[], name: string) => ({
    get isVisible() {
      return state.visible;
    },
    setText: (text: string) => {
      state.text = text;
      record.calls.push(`${name}.setText:${text}`);
    },
    show: () => {
      state.visible = true;
      record.calls.push(`${name}.show`);
    },
    hide: () => {
      state.visible = false;
      record.calls.push(`${name}.hide`);
    },
    onClick: (cb: () => void) => {
      list.push(cb);
    },
    offClick: (cb: () => void) => {
      const at = list.indexOf(cb);
      if (at >= 0) list.splice(at, 1);
    },
    showProgress: () => {
      state.progress = true;
    },
    hideProgress: () => {
      state.progress = false;
    },
    enable: () => {
      state.enabled = true;
    },
    disable: () => {
      state.enabled = false;
    },
    setParams: (params: { color?: string; text_color?: string }) => {
      if (params.color) state.color = params.color;
      if (params.text_color) state.textColor = params.text_color;
      record.calls.push(`${name}.setParams`);
    },
  });
  const params = new URLSearchParams(options.initData);
  const rawUser = params.get('user');
  const parseUser = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  const webApp: Record<string, unknown> & { viewportStableHeight: number; viewportHeight: number } =
    {
      initData: options.initData,
      initDataUnsafe: {
        start_param: options.startParam,
        user: rawUser ? parseUser(rawUser) : undefined,
      },
      version: options.version,
      platform: options.platform ?? 'android',
      colorScheme: options.colorScheme ?? 'light',
      themeParams: options.themeParams ?? {},
      viewportStableHeight: options.stableHeight ?? 720,
      viewportHeight: options.stableHeight ?? 720,
      isExpanded: false,
      ready: () => record.calls.push('ready'),
      expand: () => {
        webApp.isExpanded = true;
        record.calls.push('expand');
      },
      close: () => {
        record.closed = true;
        record.calls.push('close');
      },
      isVersionAtLeast: (v: string) => atLeast(options.version, v),
      onEvent: (event: string, cb: (...args: unknown[]) => void) => {
        (listeners[event] ??= []).push(cb);
      },
      offEvent: (event: string, cb: (...args: unknown[]) => void) => {
        const list = listeners[event] ?? [];
        const at = list.indexOf(cb);
        if (at >= 0) list.splice(at, 1);
      },
      openLink: (url: string) => {
        record.links.push(url);
        record.calls.push(`openLink:${url}`);
      },
      openTelegramLink: (url: string) => {
        record.links.push(url);
      },
      BackButton: {
        get isVisible() {
          return record.backButton.visible;
        },
        show: () => {
          record.backButton.visible = true;
          record.calls.push('BackButton.show');
        },
        hide: () => {
          record.backButton.visible = false;
          record.calls.push('BackButton.hide');
        },
        onClick: (cb: () => void) => {
          handlers.back.push(cb);
        },
        offClick: (cb: () => void) => {
          const at = handlers.back.indexOf(cb);
          if (at >= 0) handlers.back.splice(at, 1);
        },
      },
      MainButton: button(record.mainButton, handlers.main, 'MainButton'),
    };
  if (record.secondaryButton) {
    webApp.SecondaryButton = button(record.secondaryButton, handlers.secondary, 'SecondaryButton');
  }
  if (atLeast(options.version, '6.1')) {
    webApp.HapticFeedback = {
      impactOccurred: (style: string) => record.haptics.push(`impact:${style}`),
      notificationOccurred: (type: string) => record.haptics.push(`notification:${type}`),
      selectionChanged: () => record.haptics.push('selection'),
    };
  }
  if (atLeast(options.version, '6.1')) {
    webApp.setHeaderColor = (color: string) => {
      record.chrome.header = color;
      record.calls.push(`setHeaderColor:${color}`);
    };
    webApp.setBackgroundColor = (color: string) => {
      record.chrome.background = color;
      record.calls.push(`setBackgroundColor:${color}`);
    };
  }
  if (atLeast(options.version, '7.10')) {
    webApp.setBottomBarColor = (color: string) => {
      record.chrome.bottomBar = color;
      record.calls.push(`setBottomBarColor:${color}`);
    };
  }
  if (atLeast(options.version, '6.2')) {
    webApp.showPopup = (params: FakeWebAppRecord['popups'][number], cb?: (id: string) => void) => {
      if (pendingPopup !== null) throw new Error('WebAppPopupOpened');
      record.popups.push(params);
      record.calls.push(`showPopup:${params.message}`);
      pendingPopup = cb ?? null;
    };
    webApp.enableClosingConfirmation = () => {
      record.closingConfirmation = true;
      record.calls.push('enableClosingConfirmation');
    };
    webApp.disableClosingConfirmation = () => {
      record.closingConfirmation = false;
      record.calls.push('disableClosingConfirmation');
    };
  }
  if (record.settingsButton) {
    const state = record.settingsButton;
    webApp.SettingsButton = {
      show: () => {
        state.visible = true;
        record.calls.push('SettingsButton.show');
      },
      hide: () => {
        state.visible = false;
        record.calls.push('SettingsButton.hide');
      },
      onClick: (cb: () => void) => handlers.settings.push(cb),
      offClick: (cb: () => void) => {
        const at = handlers.settings.indexOf(cb);
        if (at >= 0) handlers.settings.splice(at, 1);
      },
    };
  }
  if (atLeast(options.version, '6.9') && options.writeAccess !== undefined) {
    webApp.requestWriteAccess = (cb?: (granted: boolean) => void) => {
      record.calls.push('requestWriteAccess');
      cb?.(options.writeAccess === true);
    };
  }
  if (atLeast(options.version, '7.7')) {
    webApp.disableVerticalSwipes = () => record.calls.push('disableVerticalSwipes');
    webApp.enableVerticalSwipes = () => record.calls.push('enableVerticalSwipes');
  }
  if (atLeast(options.version, '8.0')) {
    webApp.downloadFile = (
      request: { url: string; file_name: string },
      cb?: (accepted: boolean) => void,
    ) => {
      record.downloads.push(request);
      record.calls.push(`downloadFile:${request.file_name}`);
      cb?.(true);
    };
  }
  (window as unknown as { Telegram: unknown }).Telegram = { WebApp: webApp };
  window.__tg = record;
}
