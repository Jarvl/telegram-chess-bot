import type { PublicId } from './ids';

/** Inline-button callback payloads; everything else on a card is a URL button (spec §5.3). */
export type CallbackData =
  | { action: 'accept_challenge'; challengeId: PublicId }
  | { action: 'decline_challenge'; challengeId: PublicId }
  | { action: 'rematch'; gameId: PublicId };

const CALLBACK_PATTERN = /^(ch\/acc|ch\/dec|gm\/rem)\/([A-Za-z0-9]{10})$/;

export function encodeCallbackData(data: CallbackData): string {
  switch (data.action) {
    case 'accept_challenge':
      return `ch/acc/${data.challengeId}`;
    case 'decline_challenge':
      return `ch/dec/${data.challengeId}`;
    case 'rematch':
      return `gm/rem/${data.gameId}`;
  }
}

export function decodeCallbackData(raw: string | null | undefined): CallbackData | null {
  if (!raw) return null;
  const match = CALLBACK_PATTERN.exec(raw);
  if (!match) return null;
  const verb = match[1];
  const id = match[2];
  if (!verb || !id) return null;
  if (verb === 'ch/acc') return { action: 'accept_challenge', challengeId: id };
  if (verb === 'ch/dec') return { action: 'decline_challenge', challengeId: id };
  return { action: 'rematch', gameId: id };
}
