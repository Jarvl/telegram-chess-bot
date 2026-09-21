import { t } from '@group-chess/shared';
import { signal } from '@preact/signals';

type Pending = {
  message: string;
  confirmLabel: string;
  danger: boolean;
  resolve: (answer: boolean) => void;
};

const pending = signal<Pending | null>(null);

/** A bottom sheet with Cancel and one confirm action; resolves the answer. */
export function confirmDialog(
  message: string,
  options: { confirmLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  pending.value?.resolve(false);
  return new Promise((resolve) => {
    pending.value = {
      message,
      confirmLabel: options.confirmLabel ?? t('app.game.confirm'),
      danger: options.danger ?? false,
      resolve,
    };
  });
}

export function Dialogs() {
  const current = pending.value;
  if (!current) return null;
  const answer = (value: boolean) => {
    pending.value = null;
    current.resolve(value);
  };
  return (
    <div class="dialog-backdrop" onClick={() => answer(false)}>
      <div class="dialog" role="dialog" onClick={(event) => event.stopPropagation()}>
        <p>{current.message}</p>
        <div class="actions">
          <button class="btn secondary" data-dialog="cancel" onClick={() => answer(false)}>
            {t('app.game.cancel')}
          </button>
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
