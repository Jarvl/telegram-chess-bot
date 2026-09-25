import { t } from '@group-chess/shared';
import { useEffect, useRef } from 'preact/hooks';
import type { GameStore } from '../../state/game';
import { useApp } from '../context';

/** `locked` while a move waits for Confirm move: the board holds that move, so the strip can't switch position. */
export function MoveList(props: { store: GameStore; locked?: boolean }) {
  const { store } = props;
  const { tg } = useApp();
  const dto = store.dto.value;
  const moves = dto.moves;
  const viewing = store.position.value.ply;
  const premoves = store.premoveMode.value ? store.premoves.value : [];
  const labels = store.premoveLabels.value;
  const step = store.shownStep.value;
  const strip = useRef<HTMLDivElement>(null);
  // A new move or premove scrolls the strip to its end, unless the viewer is replaying an earlier move.
  useEffect(() => {
    const element = strip.current;
    if (element && store.isLatest.value) element.scrollLeft = element.scrollWidth;
  }, [moves.length, premoves.length]);
  if (moves.length === 0 && premoves.length === 0)
    return <p class="move-list hint">{t('app.game.no_moves')}</p>;
  const viewPremove = (k: number) => {
    if (store.viewPremove(k)) tg.hapticSelection();
  };
  const chained = premoves.length > 0;
  return (
    <div class="move-list" ref={strip}>
      {moves.map((move) => {
        const last = move.ply === dto.plyCount;
        const current = chained ? last && step === 0 : viewing === move.ply;
        return (
          <>
            {move.ply % 2 === 1 ? <span class="number">{Math.ceil(move.ply / 2)}.</span> : null}
            <button
              key={move.ply}
              data-ply={move.ply}
              aria-current={current ? 'true' : 'false'}
              disabled={props.locked}
              onClick={() => (chained && last ? viewPremove(0) : store.viewPly(move.ply))}
            >
              {move.san}
            </button>
          </>
        );
      })}
      {premoves.map((_, index) => {
        const reply = dto.plyCount + 1 + 2 * index;
        const own = reply + 1;
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
              data-premove={index + 1}
              aria-current={step === index + 1 ? 'true' : 'false'}
              onClick={() => viewPremove(index + 1)}
            >
              {labels[index]}
            </button>
          </>
        );
      })}
    </div>
  );
}
