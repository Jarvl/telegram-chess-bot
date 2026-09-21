import { ratingLabel, type Colour, type GameDto } from '@group-chess/shared';
import { clockLabel, isUrgent, remainingMs } from '../../state/clock';

export function PlayerBar(props: { dto: GameDto; colour: Colour; now: Date }) {
  const { dto, colour } = props;
  const player = dto[colour];
  const toMove =
    dto.status === 'active' && (dto.fen.split(' ')[1] === 'b' ? 'black' : 'white') === colour;
  const remaining = toMove ? remainingMs(dto.deadlineAt, props.now) : null;
  const rating = ratingLabel(player.rating, player.provisional);
  const after =
    dto.status === 'finished' && player.ratingAfter !== null && player.provisionalAfter !== null
      ? ` → ${ratingLabel(player.ratingAfter, player.provisionalAfter)}`
      : '';
  return (
    <div class="player-bar" data-colour={colour}>
      <span class="name">
        {player.name}
        <span class="rating">
          {rating}
          {after}
        </span>
      </span>
      {dto.status === 'active' ? (
        <span
          class={`clock ${toMove ? 'active' : ''} ${toMove && isUrgent(remaining, dto.timePerMove) ? 'urgent' : ''}`}
        >
          {clockLabel(remaining, dto.timePerMove, toMove)}
        </span>
      ) : null}
    </div>
  );
}
