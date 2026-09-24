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
/** The prototype's camera glyph, filled in the pill's text colour. */
const CAMERA =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#f5f0dc" fill-rule="evenodd" d="M9 4.5h6l1.4 2H20a1.5 1.5 0 0 1 1.5 1.5v10A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18V8A1.5 1.5 0 0 1 4 6.5h3.6L9 4.5Zm3 4a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Zm0 2a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z"/></svg>';

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

/** One line that ends in an ellipsis instead of wrapping. */
const ONE_LINE: Style = {
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  minWidth: 0,
};

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

function pill(text: string): El {
  return el(
    'div',
    {
      display: 'flex',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: 16,
      padding: '12px 26px 12px 20px',
      borderRadius: 999,
      background: '#153a26',
      color: PAGE,
      fontSize: 30,
      fontWeight: 700,
      lineHeight: 1,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      whiteSpace: 'nowrap',
    },
    [el('img', {}, [], { src: svgDataUri(CAMERA), width: 36, height: 36 }), el('span', {}, [text])],
  );
}

function playerRow(player: SnapshotPlayer): El {
  const dot: Style =
    player.colour === 'white'
      ? { background: '#ffffff', border: '3px solid #c9c2ab' }
      : { background: '#2b2b2b' };
  return el('div', { display: 'flex', alignItems: 'center', gap: 20 }, [
    el('div', { width: 34, height: 34, borderRadius: 17, flexShrink: 0, ...dot }),
    el('span', { fontSize: 46, fontWeight: 600, lineHeight: 1, flexShrink: 1, ...ONE_LINE }, [
      player.name,
    ]),
    ...(player.rating
      ? [el('span', { fontSize: 38, color: MUTED, lineHeight: 1, flexShrink: 0 }, [player.rating])]
      : []),
  ]);
}

function cell(value: SnapshotCell | null): El {
  const current: Style = value?.current
    ? { background: '#e3f1e7', color: GREEN, fontWeight: 700 }
    : {};
  return el(
    'div',
    { display: 'flex', flex: 1 },
    value
      ? [
          el('span', { padding: '2px 14px', marginLeft: -14, borderRadius: 12, ...current }, [
            value.san,
          ]),
        ]
      : [],
  );
}

function moveRow(row: SnapshotRow): El {
  return el('div', { display: 'flex', opacity: row.faded ? 0.25 : 1 }, [
    el('span', { width: 90, flexShrink: 0, color: '#9a9a8e' }, [`${row.number}.`]),
    cell(row.white),
    cell(row.black),
  ]);
}

/** §1.2, top to bottom: pill, players, divider, moves, footer. */
function panel(model: SnapshotModel): El {
  return el(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      flex: 1,
      minWidth: 0,
      padding: '44px 56px',
      gap: 26,
    },
    [
      pill(model.pill),
      el(
        'div',
        { display: 'flex', flexDirection: 'column', gap: 22 },
        model.players.map(playerRow),
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
          gap: 10,
          fontSize: 36,
          lineHeight: 1.15,
        },
        model.rows.map(moveRow),
      ),
      el('div', { display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0 }, [
        el('span', { fontSize: 40, fontWeight: 700, color: GREEN, ...ONE_LINE }, [model.status]),
        el('span', { fontSize: 32, color: MUTED, ...ONE_LINE }, [model.group]),
        el('span', { fontSize: 32, color: MUTED, ...ONE_LINE }, [model.terms]),
      ]),
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
