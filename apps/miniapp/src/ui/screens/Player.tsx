import { PlayerPageDtoSchema, t } from '@group-chess/shared';
import { useApp } from '../context';
import { playerLabel } from '../format';
import { useResource } from '../hooks';
import { GameRow } from '../rows';
import { ErrorScreen, Loading } from './Status';

export function Player(props: { groupId: string; userId: string }) {
  const { client, router } = useApp();
  const page = useResource(`player:${props.groupId}:${props.userId}`, () =>
    client.get(`/api/groups/${props.groupId}/players/${props.userId}`, PlayerPageDtoSchema),
  );
  if (page.error) return <ErrorScreen onRetry={() => void page.reload()} />;
  if (!page.data) return <Loading />;
  const { player, headToHead, recentGames } = page.data;
  return (
    <div class="screen">
      <h1 class="title">{playerLabel(player)}</h1>
      <p class="subtitle">
        {t('app.player.record', player.record)} ·{' '}
        {t('app.player.games', { count: player.gamesPlayed })}
      </p>
      <p class="hint">{t('app.player.head_to_head', headToHead)}</p>
      <div class="section">{t('app.player.recent')}</div>
      <div class="list">
        {recentGames.map((game) => (
          <GameRow
            key={game.id}
            game={game}
            onOpen={(gameId) => router.push({ name: 'game', gameId })}
          />
        ))}
      </div>
    </div>
  );
}
