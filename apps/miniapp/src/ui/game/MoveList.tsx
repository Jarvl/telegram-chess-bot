import { t } from '@group-chess/shared';
import { useEffect, useRef } from 'preact/hooks';
import type { GameStore } from '../../state/game';
import { useApp } from '../context';

/**
 * `locked` while a move waits for Confirm move: the board holds that move, so the strip can't switch
 * position. `onRemove(k)` drops premove k and the ones after it; its ✕ sits on the shown premove.
 */
export function MoveList(props: {
  store: GameStore;
  locked?: boolean;
  onRemove?: (step: number) => void;
}) {
  const { store } = props;
  const { tg } = useApp();
  const dto = store.dto.value;
  const moves = dto.moves;
  const at = store.timelineAt.value;
  // The chips stay while an earlier move is shown, as the slider keeps its premove stretch.
  const premoves = store.premoveOpen.value ? store.premoves.value : [];
  const labels = store.premoveLabels.value;
  const strip = useRef<HTMLDivElement>(null);
  // A new move or premove scrolls the strip to its end, unless the viewer is replaying an earlier move.
  useEffect(() => {
    const element = strip.current;
    if (element && store.isLatest.value) element.scrollLeft = element.scrollWidth;
  }, [moves.length, premoves.length]);
  if (moves.length === 0 && premoves.length === 0)
    return <p class="move-list hint">{t('app.game.no_moves')}</p>;
  const view = (index: number) => {
    if (store.viewTimeline(index)) tg.hapticSelection();
  };
  return (
    <div class="move-list" ref={strip}>
      {moves.map((move) => (
        <>
          {move.ply % 2 === 1 ? <span class="number">{Math.ceil(move.ply / 2)}.</span> : null}
          <button
            key={move.ply}
            data-ply={move.ply}
            aria-current={at === move.ply ? 'true' : 'false'}
            disabled={props.locked}
            onClick={() => view(move.ply)}
          >
            {move.san}
          </button>
        </>
      ))}
      {premoves.map((_, index) => {
        const reply = dto.plyCount + 1 + 2 * index;
        const own = reply + 1;
        const step = index + 1;
        const shown = at === dto.plyCount + step;
        return (
          <>
            {reply % 2 === 1 ? <span class="number">{Math.ceil(reply / 2)}.</span> : null}
            <span class="premove-gap">…</span>
            {own % 2 === 1 ? (
              <span class="number premove-number">{Math.ceil(own / 2)}.</span>
            ) : null}
            <button
              key={`premove-${index}`}
              class="premove-chip"
              data-premove={step}
              aria-current={shown ? 'true' : 'false'}
              onClick={() => view(dto.plyCount + step)}
            >
              {labels[index]}
            </button>
            {shown && props.onRemove ? (
              <button
                class="premove-remove"
                data-action="premove-remove"
                aria-label={t('app.game.premove_remove')}
                onClick={() => props.onRemove?.(step)}
              >
                ✕
              </button>
            ) : null}
          </>
        );
      })}
    </div>
  );
}
