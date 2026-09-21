import { t } from '@group-chess/shared';
import type { GameStore } from '../../state/game';

export function MoveList(props: { store: GameStore }) {
  const { store } = props;
  const moves = store.dto.value.moves;
  const viewing = store.position.value.ply;
  if (moves.length === 0) return <p class="move-list hint">{t('app.game.no_moves')}</p>;
  return (
    <div class="move-list">
      {moves.map((move) => (
        <>
          {move.ply % 2 === 1 ? <span class="number">{Math.ceil(move.ply / 2)}.</span> : null}
          <button
            key={move.ply}
            data-ply={move.ply}
            aria-current={viewing === move.ply ? 'true' : 'false'}
            onClick={() => store.viewPly(move.ply)}
          >
            {move.san}
          </button>
        </>
      ))}
      {!store.isLatest.value ? (
        <button class="badge" data-action="latest" onClick={() => store.viewPly(null)}>
          {t('app.game.latest')}
        </button>
      ) : null}
    </div>
  );
}
