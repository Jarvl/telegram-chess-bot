import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import { BOARD_DARK, BOARD_LIGHT, IMAGE_SIZE, isLightSquare, renderBoardSvg } from './board';
import type { SnapshotFonts } from './fonts';
import type { SnapshotCell, SnapshotModel, SnapshotPlayer, SnapshotRow } from './snapshotModel';

/** Snapshot spec §1: the board on the left, the panel on the right. */
export const CARD_WIDTH = 1664;
export const CARD_HEIGHT = 1024;

const SQUARE = IMAGE_SIZE / 8;
const FILES = 'abcdefgh';
const PAGE = '#f5f0dc';
const INK = '#15181d';
const MUTED = '#707579';
const GREEN = '#256b42';
const DEEP_GREEN = '#153a26';
const DOT = 28;
const DOT_GAP = 18;
const NAME_LINE_HEIGHT = 1.15;

/** Characters, not UTF-16 units, so an emoji counts once. */
const length = (text: string): number => [...text].length;

/** The group title drops a size once it is long enough to wrap onto a third line. */
export function groupFontSize(group: string): number {
  return length(group) > 60 ? 30 : 34;
}

/** Both names share one size, set by the longer, so the two rows stay alike. */
export function nameFontSize(players: readonly SnapshotPlayer[]): number {
  const longest = Math.max(...players.map((player) => length(player.name)));
  return longest <= 16 ? 40 : longest <= 22 ? 34 : 30;
}

type Style = Record<string, string | number>;
type Child = El | string;
/** The element shape Satori reads; plain objects, so the server needs no React. */
type El = { type: string; props: Record<string, unknown> };

function el(
  type: string,
  style: Style,
  children: Child[] = [],
  attributes: Record<string, unknown> = {},
): El {
  return {
    type,
    props: { ...attributes, style, ...(children.length ? { children } : {}) },
  };
}

const svgDataUri = (svg: string): string =>
  `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

/** Wraps anywhere, so an unbroken name or title still fits the panel. */
const WRAP: Style = { minWidth: 0, wordBreak: 'break-word' };

function coordinate(text: string, onLightSquare: boolean, position: Style): El {
  const color = onLightSquare ? BOARD_DARK : BOARD_LIGHT;
  return el(
    'span',
    { position: 'absolute', fontSize: 24, fontWeight: 700, lineHeight: 1, color, ...position },
    [text],
  );
}

/** §1.1: the board image with files along the bottom row and ranks down the left column. */
function board(model: SnapshotModel): El {
  const white = model.board.orientation === 'white';
  const labels: El[] = [];
  for (let index = 0; index < 8; index += 1) {
    const file = white ? index : 7 - index;
    const bottomRank = white ? 0 : 7;
    labels.push(
      coordinate(FILES[file]!, isLightSquare(file, bottomRank), {
        right: (7 - index) * SQUARE + 8,
        bottom: 5,
      }),
    );
    const rank = white ? 7 - index : index;
    const leftFile = white ? 0 : 7;
    labels.push(
      coordinate(String(rank + 1), isLightSquare(leftFile, rank), {
        left: 8,
        top: index * SQUARE + 7,
      }),
    );
  }
  return el(
    'div',
    { display: 'flex', position: 'relative', width: IMAGE_SIZE, height: IMAGE_SIZE, flexShrink: 0 },
    [
      el('img', { position: 'absolute', left: 0, top: 0 }, [], {
        src: svgDataUri(renderBoardSvg(model.board)),
        width: IMAGE_SIZE,
        height: IMAGE_SIZE,
      }),
      ...labels,
    ],
  );
}

/** §1.2: the group and its terms head the panel. */
function header(model: SnapshotModel): El {
  return el('div', { display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0 }, [
    el(
      'span',
      {
        fontSize: groupFontSize(model.group),
        fontWeight: 700,
        lineHeight: 1.2,
        color: DEEP_GREEN,
        ...WRAP,
      },
      [model.group],
    ),
    el('span', { fontSize: 28, lineHeight: 1.2, color: MUTED }, [model.meta]),
  ]);
}

/** A colour dot beside the name, centred on its first line, with the rating underneath. */
function playerRow(player: SnapshotPlayer, fontSize: number): El {
  const dot: Style =
    player.colour === 'white'
      ? { background: '#ffffff', border: '3px solid #c9c2ab' }
      : { background: '#2b2b2b' };
  const dotTop = Math.round((fontSize * NAME_LINE_HEIGHT - DOT) / 2);
  return el('div', { display: 'flex', flexDirection: 'column', gap: 8 }, [
    el('div', { display: 'flex', alignItems: 'flex-start', gap: DOT_GAP, minWidth: 0 }, [
      el('div', {
        width: DOT,
        height: DOT,
        marginTop: dotTop,
        borderRadius: DOT / 2,
        flexShrink: 0,
        ...dot,
      }),
      el(
        'span',
        { fontSize, fontWeight: 600, lineHeight: NAME_LINE_HEIGHT, flexShrink: 1, ...WRAP },
        [player.name],
      ),
    ]),
    ...(player.rating
      ? [
          el('span', { paddingLeft: DOT + DOT_GAP, fontSize: 30, lineHeight: 1.2, color: MUTED }, [
            player.rating,
          ]),
        ]
      : []),
  ]);
}

function cell(value: SnapshotCell | null): El {
  const current: Style = value?.current
    ? { background: '#e3f1e7', color: GREEN, fontWeight: 700 }
    : {};
  return el(
    'div',
    { display: 'flex', width: 190, flexShrink: 0 },
    value
      ? [
          el('span', { padding: '0 12px', marginLeft: -12, borderRadius: 10, ...current }, [
            value.san,
          ]),
        ]
      : [],
  );
}

function moveRow(row: SnapshotRow): El {
  return el('div', { display: 'flex', flexShrink: 0 }, [
    el('span', { width: 84, flexShrink: 0, color: '#9a9a8e' }, [`${row.number}.`]),
    cell(row.white),
    cell(row.black),
  ]);
}

/** §1.2, top to bottom: group and terms, players, divider, moves, then a finished game's result. */
function panel(model: SnapshotModel): El {
  const nameSize = nameFontSize(model.players);
  return el(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      flex: 1,
      minWidth: 0,
      padding: '56px 64px',
      gap: 40,
    },
    [
      header(model),
      el(
        'div',
        { display: 'flex', flexDirection: 'column', gap: 26, flexShrink: 0 },
        model.players.map((player) => playerRow(player, nameSize)),
      ),
      el('div', { height: 3, background: '#e2dcc6', flexShrink: 0 }),
      el(
        'div',
        {
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          gap: 14,
          fontSize: 34,
          lineHeight: 1.2,
        },
        model.rows.map(moveRow),
      ),
      ...(model.status
        ? [
            el(
              'span',
              { flexShrink: 0, fontSize: 34, fontWeight: 700, lineHeight: 1.2, color: GREEN },
              [model.status],
            ),
          ]
        : []),
    ],
  );
}

/** Satori lays the card out and turns its text into paths, so resvg needs no fonts (§1.3). */
export async function renderSnapshotSvg(
  model: SnapshotModel,
  fonts: SnapshotFonts,
): Promise<string> {
  const card = el(
    'div',
    {
      display: 'flex',
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      background: PAGE,
      color: INK,
      fontFamily: 'Noto Sans',
    },
    [board(model), panel(model)],
  );
  return satori(card as unknown as Parameters<typeof satori>[0], {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    fonts,
  });
}

export function renderSnapshotPng(svg: string): Buffer {
  return new Resvg(svg, { fitTo: { mode: 'width', value: CARD_WIDTH } }).render().asPng();
}
