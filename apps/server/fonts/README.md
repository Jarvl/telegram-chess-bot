# Snapshot card fonts

The shared-position image draws its text with these fonts. The binaries are not in git:
`pnpm fonts` (`scripts/fetch-fonts.mjs`) downloads them here from the pinned URLs and checks each
one's sha256. Tests fetch them automatically; the Docker image fetches them in its `fonts` stage.

| File                                   | Source                                            | Copyright                     |
| -------------------------------------- | ------------------------------------------------- | ----------------------------- |
| `NotoSans-{Regular,SemiBold,Bold}.ttf` | notofonts/notofonts.github.io @ e0ad9f1           | 2022 The Noto Project Authors |
| `NotoEmoji-Regular.ttf`                | fonts.gstatic.com, Noto Emoji v65 static instance | 2013 Google LLC               |
| `NotoSansSymbols2-Regular.ttf`         | notofonts/notofonts.github.io @ e0ad9f1           | 2022 The Noto Project Authors |
| `NotoSansCJKsc-Regular.otf`            | notofonts/noto-cjk, tag Sans2.004                 | 2014-2021 Adobe               |

All are licensed under the SIL Open Font License 1.1 (`OFL.txt`). They are used unmodified.
