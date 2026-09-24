import bannerUrl from './assets/goat-banner.jpg';
import markUrl from './assets/goat-mark.png';

/** Who and what the app is; the one place these names are spelled out (redesign spec §1). */
export const BRAND = {
  name: 'Chess Goat',
  author: 'Jarvl',
  repository: 'Jarvl/telegram-chess-bot',
  markUrl,
  bannerUrl,
} as const;

export const AUTHOR_URL = `https://t.me/${BRAND.author}`;
export const REPO_URL = `https://github.com/${BRAND.repository}`;
