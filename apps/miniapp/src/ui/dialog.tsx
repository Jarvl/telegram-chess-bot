import { t } from '@group-chess/shared';
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { Tg } from '../tg/webapp';
import { useApp } from './context';

type Request = {
  title?: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  /** False for a message with a single OK. */
  cancellable: boolean;
};

type Pending = Request & { resolve: (answer: boolean) => void };

const pending = signal<Pending | null>(null);
/** The client of the mounted <Dialogs />: questions go to its native popup when it has one. */
let host: Tg | null = null;

function ask(request: Request): Promise<boolean> {
  const native = host?.showPopup({
    ...(request.title ? { title: request.title } : {}),
    message: request.message,
    buttons: request.cancellable
      ? [
          { id: 'cancel', type: 'cancel' },
          {
            id: 'confirm',
            type: request.danger ? 'destructive' : 'default',
            text: request.confirmLabel,
          },
        ]
      : [{ id: 'confirm', type: 'ok' }],
  });
  if (native) return native.then((id) => id === 'confirm');
  pending.value?.resolve(false);
  return new Promise((resolve) => {
    pending.value = { ...request, resolve };
  });
}

/** Cancel and one confirm action: Telegram's popup from 6.2, a bottom sheet below. */
export function confirmDialog(
  message: string,
  options: { confirmLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return ask({
    message,
    confirmLabel: options.confirmLabel ?? t('app.game.confirm'),
    danger: options.danger ?? false,
    cancellable: true,
  });
}

/** A message with a single OK, such as the About box. */
export async function infoDialog(message: string, title?: string): Promise<void> {
  await ask({
    title,
    message,
    confirmLabel: t('app.common.ok'),
    danger: false,
    cancellable: false,
  });
}

export function Dialogs() {
  const { tg } = useApp();
  useEffect(() => {
    host = tg;
    return () => {
      if (host === tg) host = null;
    };
  }, [tg]);
  const current = pending.value;
  if (!current) return null;
  const answer = (value: boolean) => {
    pending.value = null;
    current.resolve(value);
  };
  return (
    <div class="dialog-backdrop" onClick={() => answer(false)}>
      <div class="dialog" role="dialog" onClick={(event) => event.stopPropagation()}>
        {current.title ? <strong>{current.title}</strong> : null}
        <p>{current.message}</p>
        <div class="actions">
          {current.cancellable ? (
            <button class="btn secondary" data-dialog="cancel" onClick={() => answer(false)}>
              {t('app.game.cancel')}
            </button>
          ) : null}
          <button
            class={`btn ${current.danger ? 'danger' : ''}`}
            data-dialog="confirm"
            onClick={() => answer(true)}
          >
            {current.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
