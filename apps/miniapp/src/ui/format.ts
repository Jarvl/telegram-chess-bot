import {
  endReasonLabel,
  ratedLabel,
  ratingLabel,
  resultLabel,
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

/** The second line of a game row. */
export function summaryStatus(summary: GameSummary): string {
  if (summary.status === 'finished') {
    const result = summary.result ? resultLabel(summary.result) : '';
    const reason = summary.endReason ? endReasonLabel(summary.endReason) : '';
    return [result, reason].filter(Boolean).join(' · ');
  }
  const mover = summary.sideToMove === 'white' ? summary.white.name : summary.black.name;
  return `${t('app.lobby.to_move', { name: mover })} · ${termsLabel(summary.timePerMove, summary.rated)}`;
}
