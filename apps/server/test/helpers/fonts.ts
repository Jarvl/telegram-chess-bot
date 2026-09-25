import { fetchFonts } from '../../../../scripts/fetch-fonts.mjs';

/** Every server test run, unit tests included, gets the snapshot card's fonts (spec §2.2). */
export default async function setup(): Promise<void> {
  await fetchFonts();
}
