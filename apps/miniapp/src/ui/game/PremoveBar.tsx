import { t } from '@group-chess/shared';
import type { GameStore } from '../../state/game';
import { useApp } from '../context';

/** The premove stepper under the move strip (premoves spec, Stepper). */
export function PremoveBar(props: {
  store: GameStore;
  onRemove: (step: number) => void;
  busy?: boolean;
}) {
  const { store } = props;
  const { tg } = useApp();
  const length = store.premoves.value.length;
  if (!store.premoveMode.value || length === 0) return null;
  const step = store.shownStep.value;
  const go = (value: number) => {
    if (store.viewPremove(value)) tg.hapticSelection();
  };
  return (
    <div class="premove-bar">
      <button
        class="pill-btn"
        data-action="premove-prev"
        aria-label={t('app.game.premove_prev')}
        disabled={step === 0}
        onClick={() => go(step - 1)}
      >
        ◀
      </button>
      <span class={step === 0 ? 'premove-label' : 'premove-label pending'}>
        {step === 0
          ? t('app.game.premove_current')
          : t('app.game.premove_step', { k: step, n: length })}
      </span>
      {step > 0 ? (
        <button
          class="pill-btn"
          data-action="premove-remove"
          disabled={props.busy}
          onClick={() => props.onRemove(step)}
        >
          {t('app.game.premove_remove')}
        </button>
      ) : null}
      <button
        class="pill-btn"
        data-action="premove-next"
        aria-label={t('app.game.premove_next')}
        disabled={step === length}
        onClick={() => go(step + 1)}
      >
        ▶
      </button>
    </div>
  );
}
