import {
  FinishedPageDtoSchema,
  GameDtoSchema,
  LobbyDtoSchema,
  t,
  type GameSummary,
  type LobbyDto,
} from '@group-chess/shared';
import { useState } from 'preact/hooks';
import { ApiError } from '../../api/client';
import type { LobbyTab } from '../../router';
import { useApp } from '../context';
import { useResource } from '../hooks';
import { ChallengeRow, GameRow, PlayerRow } from '../rows';
import { toast } from '../toast';
import { ErrorScreen, Loading } from './Status';

const TABS: LobbyTab[] = ['active', 'finished', 'players'];

function byYourMoveFirst(games: GameSummary[]): GameSummary[] {
  return [...games].sort((a, b) => Number(b.yourTurn) - Number(a.yourTurn));
}

export function Lobby(props: { groupId: string; tab?: LobbyTab }) {
  const { client, router, prefetched } = useApp();
  const initial = prefetched.lobby?.group.id === props.groupId ? prefetched.lobby : undefined;
  if (initial) delete prefetched.lobby;
  const lobby = useResource<LobbyDto>(
    `lobby:${props.groupId}`,
    () => client.get(`/api/groups/${props.groupId}`, LobbyDtoSchema),
    initial,
  );
  const [tab, setTab] = useState<LobbyTab>(props.tab ?? 'active');
  const [loadingMore, setLoadingMore] = useState(false);

  if (lobby.error) return <ErrorScreen onRetry={() => void lobby.reload()} />;
  const data = lobby.data;
  if (!data) return <Loading />;

  const openGame = (gameId: string) => router.push({ name: 'game', gameId });
  const act = async (path: string, after: () => void | Promise<void>) => {
    try {
      await client.post(path, {});
      await after();
    } catch (error) {
      if (error instanceof ApiError && error.code !== 'network') await lobby.reload();
      else toast(t('app.common.offline'));
    }
  };
  const accept = async (id: string) => {
    try {
      const game = await client.post(`/api/challenges/${id}/accept`, {}, GameDtoSchema);
      prefetched.game = game;
      router.push({ name: 'game', gameId: game.id });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'stale_state')
        toast(t('alert.accepted_first'));
      await lobby.reload();
    }
  };
  const more = async () => {
    if (!data.finished.nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await client.get(
        `/api/groups/${props.groupId}/finished?cursor=${encodeURIComponent(data.finished.nextCursor)}`,
        FinishedPageDtoSchema,
      );
      lobby.set({
        ...data,
        finished: { items: [...data.finished.items, ...page.items], nextCursor: page.nextCursor },
      });
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div class="screen">
      <h1 class="title">{data.group.title}</h1>
      <div class="actions">
        <button
          class="btn"
          data-action="new-game"
          onClick={() =>
            router.push({ name: 'newGame', groupId: props.groupId, defaults: data.settings })
          }
        >
          {t('app.lobby.new_game')}
        </button>
        {data.isAdmin ? (
          <button
            class="btn secondary"
            data-action="group-settings"
            onClick={() => router.push({ name: 'groupSettings', groupId: props.groupId })}
          >
            {t('app.lobby.settings')}
          </button>
        ) : null}
      </div>
      {data.challenges.length > 0 ? (
        <>
          <div class="section">{t('app.lobby.challenges')}</div>
          <div class="list">
            {data.challenges.map((challenge) => (
              <ChallengeRow
                key={challenge.id}
                challenge={challenge}
                onAccept={(id) => void accept(id)}
                onDecline={(id) => void act(`/api/challenges/${id}/decline`, lobby.reload)}
                onCancel={(id) => void act(`/api/challenges/${id}/cancel`, lobby.reload)}
              />
            ))}
          </div>
        </>
      ) : null}
      <div class="tabs" role="tablist">
        {TABS.map((name) => (
          <button
            key={name}
            role="tab"
            class="tab"
            data-tab={name}
            aria-selected={tab === name ? 'true' : 'false'}
            onClick={() => setTab(name)}
          >
            {t(`app.lobby.tab.${name}`)}
          </button>
        ))}
      </div>
      {tab === 'active' ? (
        <div class="list">
          {data.active.length === 0 ? <p class="row hint">{t('app.lobby.no_active')}</p> : null}
          {byYourMoveFirst(data.active).map((game) => (
            <GameRow key={game.id} game={game} onOpen={openGame} />
          ))}
        </div>
      ) : null}
      {tab === 'finished' ? (
        <>
          <div class="list">
            {data.finished.items.length === 0 ? (
              <p class="row hint">{t('app.lobby.no_finished')}</p>
            ) : null}
            {data.finished.items.map((game) => (
              <GameRow key={game.id} game={game} onOpen={openGame} />
            ))}
          </div>
          {data.finished.nextCursor ? (
            <button class="btn secondary block" disabled={loadingMore} onClick={() => void more()}>
              {t('app.common.more')}
            </button>
          ) : null}
        </>
      ) : null}
      {tab === 'players' ? (
        <div class="list">
          {data.players.length === 0 ? <p class="row hint">{t('app.lobby.no_players')}</p> : null}
          {data.players.map((entry, index) => (
            <PlayerRow
              key={entry.id}
              entry={entry}
              rank={index + 1}
              onOpen={(userId) => router.push({ name: 'player', groupId: props.groupId, userId })}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
