/** Telegram's own avatar colours, in its order (redesign spec §3.1). */
export const AVATAR_PALETTE = [
  '#e17076',
  '#faa774',
  '#a695e7',
  '#7bc862',
  '#6ec9cb',
  '#65aadd',
  '#ee7aae',
] as const;

/** Ids are decimal strings up to 19 digits, past a double's exact range, so BigInt it is. */
export function avatarColour(userId: string): string {
  return AVATAR_PALETTE[Number(BigInt(userId) % 7n)]!;
}

export function groupColour(publicId: string): string {
  let sum = 0;
  for (const char of publicId) sum += char.charCodeAt(0);
  return AVATAR_PALETTE[sum % 7]!;
}

/** The first character, whole even when it is an emoji; a username's @ is skipped. */
export function personInitial(name: string): string {
  const first = Array.from(name.replace(/^@/, '').trim())[0];
  return first ? first.toUpperCase() : '?';
}

export function groupInitials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const initials = words.map((word) => Array.from(word)[0]!.toUpperCase()).join('');
  return initials || '?';
}
