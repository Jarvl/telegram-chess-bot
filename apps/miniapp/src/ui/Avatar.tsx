import type { GroupRef, PlayerRef } from '@group-chess/shared';
import { BRAND } from '../brand';
import { avatarColour, groupColour, groupInitials, personInitial } from './avatarPalette';

type Size = 22 | 34 | 38 | 40 | 56;

export function BotMark(props: { size: Size }) {
  return (
    <img
      class="avatar bot"
      src={BRAND.markUrl}
      alt=""
      width={props.size}
      height={props.size}
      style={{ '--size': `${props.size}px` } as Record<string, string>}
    />
  );
}

/** A person as Telegram draws one without a photo; the bot as the Chess Goat mark. */
export function Avatar(props: { player: Pick<PlayerRef, 'id' | 'name' | 'isBot'>; size: Size }) {
  if (props.player.isBot) return <BotMark size={props.size} />;
  return (
    <span
      class="avatar"
      aria-hidden="true"
      style={
        {
          '--size': `${props.size}px`,
          background: avatarColour(props.player.id),
        } as Record<string, string>
      }
    >
      {personInitial(props.player.name)}
    </span>
  );
}

export function GroupAvatar(props: { group: GroupRef; size: 48 | 56 }) {
  return (
    <span
      class="avatar group"
      aria-hidden="true"
      style={
        {
          '--size': `${props.size}px`,
          background: groupColour(props.group.id),
        } as Record<string, string>
      }
    >
      {groupInitials(props.group.title)}
    </span>
  );
}
