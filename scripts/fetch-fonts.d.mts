export type FontEntry = { file: string; url: string; sha256: string };
export const FONT_MANIFEST: readonly FontEntry[];
export const FONTS_DIR: string;
export function fetchFonts(options?: {
  dir?: string;
  manifest?: readonly FontEntry[];
  fetchImpl?: typeof fetch;
}): Promise<string[]>;
