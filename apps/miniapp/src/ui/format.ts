import {
  ratedLabel,
  ratingLabel,
  t,
  timePerMoveLabel,
  type GameSummary,
  type PlayerRef,
  type TimePerMove,
} from '@group-chess/shared';

export function playerLabel(player: PlayerRef): string {
  return `${player.name} ${ratingLabel(player.rating, player.provisional)}`;
}

export function termsLabel(timePerMove: TimePerMove, rated: boolean): string {
  return t('app.lobby.terms', {
    timePerMove: timePerMoveLabel(timePerMove),
    rated: ratedLabel(rated),
  });
}

export function summaryTitle(summary: GameSummary): string {
  return `${summary.white.name} vs ${summary.black.name}`;
}
