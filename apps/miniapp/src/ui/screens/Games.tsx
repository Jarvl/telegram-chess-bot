import { MeGamesDtoSchema, t } from '@group-chess/shared';
import { useApp } from '../context';
import { useResource } from '../hooks';
import { GameRow } from '../rows';
import { ErrorScreen, Loading } from './Status';

/** The Mini App's home: every board waiting on you, across all your groups, your move first. */
export function Games() {
  const { client, router, prefetched } = useApp();
  const initial = prefetched.games;
  delete prefetched.games;
  const games = useResource('games', () => client.get('/api/me/games', MeGamesDtoSchema), initial);
  if (games.error) return <ErrorScreen onRetry={() => void games.reload()} />;
  if (!games.data) return <Loading />;
  return (
    <div class="screen">
      <h1 class="title">{t('app.games.title')}</h1>
      {games.data.items.length === 0 ? (
        <>
          <p class="hint">{t('app.games.empty')}</p>
          <button
            class="btn secondary block"
            data-action="browse-groups"
            onClick={() => router.select('groups')}
          >
            {t('app.games.browse')}
          </button>
        </>
      ) : (
        <div class="list">
          {games.data.items.map((game) => (
            <GameRow
              key={game.id}
              game={game}
              context={game.group.title}
              onOpen={(gameId) => router.push({ name: 'game', gameId })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
