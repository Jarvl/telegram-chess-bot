import { t, type ChallengeDto, type GameSummary, type LeaderboardEntry } from '@group-chess/shared';
import { playerLabel, summaryStatus, summaryTitle, termsLabel } from './format';

export function GameRow(props: { game: GameSummary; onOpen: (id: string) => void }) {
  const { game } = props;
  return (
    <button class="row" data-game={game.id} onClick={() => props.onOpen(game.id)}>
      <span class="grow">
        <span class="primary">{summaryTitle(game)}</span>
        <span class="secondary">{summaryStatus(game)}</span>
      </span>
      {game.yourTurn && game.status === 'active' ? (
        <span class="badge">{t('app.lobby.your_move')}</span>
      ) : null}
      {game.voided ? <span class="badge muted">{t('app.lobby.void_badge')}</span> : null}
    </button>
  );
}

export function ChallengeRow(props: {
  challenge: ChallengeDto;
  onAccept: (id: string) => void;
  onDecline: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const { challenge } = props;
  const line = challenge.opponent
    ? t('app.lobby.challenge.direct', {
        challenger: challenge.challenger.name,
        opponent: challenge.opponent.name,
      })
    : t('app.lobby.challenge.open', { challenger: challenge.challenger.name });
  return (
    <div class="row">
      <span class="grow">
        <span class="primary">{line}</span>
        <span class="secondary">{termsLabel(challenge.timePerMove, challenge.rated)}</span>
      </span>
      {challenge.viewer.canAccept ? (
        <button class="btn" data-accept={challenge.id} onClick={() => props.onAccept(challenge.id)}>
          {t('button.accept')}
        </button>
      ) : null}
      {challenge.viewer.canDecline ? (
        <button
          class="btn secondary"
          data-decline={challenge.id}
          onClick={() => props.onDecline(challenge.id)}
        >
          {t('button.decline')}
        </button>
      ) : null}
      {challenge.viewer.canCancel ? (
        <button
          class="btn secondary"
          data-cancel={challenge.id}
          onClick={() => props.onCancel(challenge.id)}
        >
          {t('button.cancel')}
        </button>
      ) : null}
    </div>
  );
}

export function PlayerRow(props: {
  entry: LeaderboardEntry;
  rank?: number;
  onOpen: (id: string) => void;
}) {
  const { entry } = props;
  return (
    <button class="row" data-player={entry.id} onClick={() => props.onOpen(entry.id)}>
      {props.rank !== undefined ? <span class="hint">{props.rank}</span> : null}
      <span class="grow">
        <span class="primary">{playerLabel(entry)}</span>
        <span class="secondary">{t('app.player.record', entry.record)}</span>
      </span>
      <span class="hint">{t('app.player.games', { count: entry.gamesPlayed })}</span>
    </button>
  );
}
