import type { PublicId } from './ids';

/** What a Mini App direct link opens (spec §5.3). */
export type StartParam =
  | { kind: 'game'; gameId: PublicId }
  | { kind: 'lobby'; groupId: PublicId }
  /** The group's New game form, for a chat button that says "challenge someone". */
  | { kind: 'newGame'; groupId: PublicId }
  | { kind: 'settings'; groupId: PublicId };

const START_PARAM_PATTERN = /^([glns])_([A-Za-z0-9]{10})$/;

export function encodeStartParam(param: StartParam): string {
  switch (param.kind) {
    case 'game':
      return `g_${param.gameId}`;
    case 'lobby':
      return `l_${param.groupId}`;
    case 'newGame':
      return `n_${param.groupId}`;
    case 'settings':
      return `s_${param.groupId}`;
  }
}

export function decodeStartParam(raw: string | null | undefined): StartParam | null {
  if (!raw) return null;
  const match = START_PARAM_PATTERN.exec(raw);
  if (!match) return null;
  const prefix = match[1];
  const id = match[2];
  if (!prefix || !id) return null;
  if (prefix === 'g') return { kind: 'game', gameId: id };
  if (prefix === 'l') return { kind: 'lobby', groupId: id };
  if (prefix === 'n') return { kind: 'newGame', groupId: id };
  return { kind: 'settings', groupId: id };
}
