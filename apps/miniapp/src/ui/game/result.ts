import { endReasonLabel, ratingLabel, resultLabel, t, type GameDto } from '@group-chess/shared';

/** The result banner text from the viewer's side (PRD §8.2). */
export function resultForViewer(dto: GameDto): string {
  if (!dto.result || dto.result === '*') return t('app.game.result.aborted');
  if (dto.result === '1/2-1/2') return t('app.game.result.draw');
  const winner = dto.result === '1-0' ? 'white' : 'black';
  if (dto.viewerRole === 'spectator') return t(`app.game.result.${winner}`);
  return t(dto.viewerRole === winner ? 'app.game.result.win' : 'app.game.result.loss');
}

export function reasonForViewer(dto: GameDto): string | null {
  return dto.endReason ? endReasonLabel(dto.endReason) : null;
}

/** `1500? → 1662?` for the viewer of a finished rated game; null otherwise. */
export function ratingChangeFor(dto: GameDto): string | null {
  if (dto.status !== 'finished' || !dto.rated || dto.voided) return null;
  if (dto.viewerRole !== 'white' && dto.viewerRole !== 'black') return null;
  const player = dto[dto.viewerRole];
  if (player.ratingAfter === null || player.provisionalAfter === null) return null;
  return `${ratingLabel(player.rating, player.provisional)} → ${ratingLabel(player.ratingAfter, player.provisionalAfter)}`;
}

/** The result card's second line: how it ended, the score, and the viewer's rating change. */
export function resultDetail(dto: GameDto): string {
  return [
    reasonForViewer(dto),
    dto.result && dto.result !== '*' ? resultLabel(dto.result) : null,
    ratingChangeFor(dto),
  ]
    .filter(Boolean)
    .join(' · ');
}
