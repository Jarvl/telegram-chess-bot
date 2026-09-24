import { ratingLabel, t, type Colour, type GameDto } from '@group-chess/shared';
import { clockLabel, isUrgent, remainingMs } from '../../state/clock';
import { Avatar } from '../Avatar';

export function PlayerBar(props: { dto: GameDto; colour: Colour; now: Date }) {
  const { dto, colour } = props;
  const player = dto[colour];
  const toMove =
    dto.status === 'active' && (dto.fen.split(' ')[1] === 'b' ? 'black' : 'white') === colour;
  const yours = toMove && dto.viewerRole === colour;
  const remaining = toMove ? remainingMs(dto.deadlineAt, props.now) : null;
  const urgent = toMove && isUrgent(remaining, dto.timePerMove);
  const rating = player.isBot
    ? dto.engineLevel
      ? t(`app.level.${dto.engineLevel}`)
      : ''
    : ratingLabel(player.rating, player.provisional) +
      (dto.status === 'finished' && player.ratingAfter !== null && player.provisionalAfter !== null
        ? ` → ${ratingLabel(player.ratingAfter, player.provisionalAfter)}`
        : '');
  const sub = yours
    ? t('app.lobby.your_move')
    : toMove
      ? t('app.game.to_move')
      : t('app.game.side_in_group', { side: t(`colour.${colour}`), group: dto.group.title });
  const clockClass = ['clock', toMove && 'active', yours && 'yours', urgent && 'urgent']
    .filter(Boolean)
    .join(' ');
  return (
    <div class={yours ? 'player-bar yours' : 'player-bar'} data-colour={colour}>
      <span class={`ring ${colour}`}>
        <Avatar player={player} size={34} />
      </span>
      <span class="who">
        <span class="name">
          {player.name} {rating ? <span class="rating">{rating}</span> : null}
        </span>
        <span class={yours ? 'sub yours' : toMove ? 'sub to-move' : 'sub'}>{sub}</span>
      </span>
      {dto.status === 'active' ? (
        <span class={clockClass}>{clockLabel(remaining, dto.timePerMove, toMove)}</span>
      ) : null}
    </div>
  );
}
