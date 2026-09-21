import { GameDtoSchema, t, type Colour, type GameDto } from '@group-chess/shared';
import { h } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ApiError } from '../../api/client';
import { GameStream } from '../../api/stream';
import type { BoardAdapter } from '../../board/adapter';
import {
  isPromotion,
  promotionOverlayStyle,
  promotionPieces,
  type PromotionPiece,
} from '../../board/promotion';
import { diffNotices, GameStore, type Notice } from '../../state/game';
import {
  reduceMove,
  type MoveEffect,
  type MoveEvent,
  type MoveState,
} from '../../state/moveMachine';
import { noteServerTime, prefs, session } from '../../state/session';
import { useApp } from '../context';
import { confirmDialog } from '../dialog';
import { toast } from '../toast';
import { Board } from './Board';
import { MoveList } from './MoveList';
import { PlayerBar } from './PlayerBar';
import { ratingChangeFor, reasonForViewer, resultForViewer } from './result';
import { useClock } from './useClock';

const PIECE_CLASS: Record<PromotionPiece, string> = {
  q: 'queen',
  r: 'rook',
  b: 'bishop',
  n: 'knight',
};

export function GameView(props: { initial: GameDto; onReload: () => Promise<GameDto> }) {
  const { client, tg, router } = useApp();
  const store = useMemo(() => new GameStore(props.initial), [props.initial.id]);
  const adapterRef = useRef<BoardAdapter | null>(null);
  const moveRef = useRef<MoveState>({ kind: 'idle' });
  const [moveState, setMoveState] = useState<MoveState>({ kind: 'idle' });
  const [promotion, setPromotion] = useState<{ orig: string; dest: string } | null>(null);
  const [inPageCancel, setInPageCancel] = useState(false);
  const now = useClock(store);
  const dto = store.dto.value;
  const gameId = dto.id;
  const isPlayer = dto.viewerRole === 'white' || dto.viewerRole === 'black';

  const notify = useCallback(
    (notice: Notice) => {
      if (notice === 'opponent_moved' || notice === 'draw_offered') tg.haptic('light');
      if (notice === 'draw_declined') toast(t('app.game.draw_declined'));
      if (notice === 'finished') tg.hapticNotify('success');
    },
    [tg],
  );
  const applyState = useCallback(
    (next: GameDto) => {
      const previous = store.dto.value;
      noteServerTime(next.serverTime);
      if (store.apply(next)) for (const notice of diffNotices(previous, next)) notify(notice);
    },
    [store, notify],
  );

  // Live updates for running games (spec §6.4); finished games are static.
  useEffect(() => {
    if (dto.status !== 'active') return;
    const stream = new GameStream({
      url: client.url(`/api/games/${gameId}/events`, { token: client.token ?? '' }),
      refresh: () => client.get(`/api/games/${gameId}`, GameDtoSchema),
      onState: applyState,
      onFailure: () =>
        void client
          .post('/api/telemetry', { events: [{ kind: 'sse_failed' }] })
          .catch(() => undefined),
    });
    stream.start();
    return () => stream.stop();
  }, [client, gameId, dto.status, applyState]);

  const restore = useCallback(() => {
    adapterRef.current?.cancelMove();
    const position = store.position.value;
    adapterRef.current?.setPosition({
      ...position,
      orientation: store.orientation.value,
      turnColour: store.sideToMove.value,
    });
  }, [store]);

  const dispatch = useCallback((event: MoveEvent) => {
    const { state, effects } = reduceMove(moveRef.current, event, {
      confirmMoves: prefs.value.confirmMoves,
    });
    moveRef.current = state;
    setMoveState(state);
    for (const effect of effects) runEffect(effect);
  }, []);

  const runEffect = (effect: MoveEffect): void => {
    switch (effect.type) {
      case 'send': {
        void client
          .post(`/api/games/${gameId}/moves`, effect.move, GameDtoSchema)
          .then((next) => {
            applyState(next);
            dispatch({ type: 'sent' });
            tg.haptic('light');
            afterSent();
          })
          .catch((error: unknown) => {
            if (error instanceof ApiError && error.isNetwork)
              dispatch({ type: 'networkError', now: Date.now() });
            else dispatch({ type: 'rejected' });
          });
        return;
      }
      case 'restore':
        restore();
        return;
      case 'reload':
        void props
          .onReload()
          .then(applyState)
          .catch(() => undefined);
        return;
      case 'closingConfirmation':
        tg.closingConfirmation(effect.on);
        return;
      case 'telemetryRetry':
        void client
          .post('/api/telemetry', { events: [{ kind: 'move_retry' }] })
          .catch(() => undefined);
        return;
    }
  };

  const afterSent = (): void => {
    if (prefs.value.closeAfterMove && session.value?.launchedFrom?.kind === 'game') {
      toast(t('app.game.sent'), 300);
      setTimeout(() => tg.close(), 300);
    }
  };

  // Retry timer: wake the machine when the backoff elapses.
  useEffect(() => {
    if (moveState.kind !== 'retry') return;
    const timer = setTimeout(
      () => dispatch({ type: 'tick', now: Date.now() }),
      Math.max(0, moveState.nextAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [moveState, dispatch]);

  // Telegram buttons per machine state (spec §6.3).
  useEffect(() => {
    switch (moveState.kind) {
      case 'pendingConfirm': {
        tg.setMainButton({
          text: t('app.game.confirm'),
          onClick: () => dispatch({ type: 'confirm' }),
        });
        const bound = tg.setSecondaryButton({
          text: t('app.game.cancel'),
          onClick: () => dispatch({ type: 'cancel' }),
        });
        setInPageCancel(!bound);
        return;
      }
      case 'sending':
        tg.setMainButton({ text: t('app.game.sending'), onClick: () => undefined, progress: true });
        tg.setSecondaryButton(null);
        setInPageCancel(false);
        return;
      case 'retry':
        tg.setMainButton({
          text: t('app.game.retry'),
          onClick: () => dispatch({ type: 'retryNow' }),
        });
        tg.setSecondaryButton(null);
        setInPageCancel(false);
        return;
      case 'idle':
        tg.setMainButton(null);
        tg.setSecondaryButton(null);
        setInPageCancel(false);
        return;
    }
  }, [moveState.kind, tg, dispatch]);
  useEffect(
    () => () => {
      tg.setMainButton(null);
      tg.setSecondaryButton(null);
      tg.closingConfirmation(false);
    },
    [tg],
  );

  const onDrop = (orig: string, dest: string, meta: { captured: boolean }): void => {
    if (moveRef.current.kind !== 'idle') {
      restore();
      return;
    }
    tg.haptic(meta.captured ? 'medium' : 'light');
    if (isPromotion(store.dto.value.fen, orig, dest)) {
      setPromotion({ orig, dest });
      return;
    }
    dispatch({ type: 'drop', uci: `${orig}${dest}`, expectedPly: store.dto.value.plyCount });
  };
  const promote = (piece: PromotionPiece | null): void => {
    const pending = promotion;
    setPromotion(null);
    if (!pending) return;
    if (!piece) {
      restore();
      return;
    }
    dispatch({
      type: 'drop',
      uci: `${pending.orig}${pending.dest}${piece}`,
      expectedPly: store.dto.value.plyCount,
    });
  };

  const action = async (path: string, body: unknown = {}): Promise<void> => {
    try {
      applyState(await client.post(`/api/games/${gameId}/${path}`, body, GameDtoSchema));
    } catch (error) {
      if (error instanceof ApiError && error.isNetwork) toast(t('app.common.offline'));
      else
        void props
          .onReload()
          .then(applyState)
          .catch(() => undefined);
    }
  };
  const share = async (): Promise<void> => {
    try {
      await client.post(`/api/games/${gameId}/share`, { ply: store.position.value.ply });
      toast(t('app.game.shared'));
    } catch (error) {
      toast(
        error instanceof ApiError && error.code === 'rate_limited'
          ? t('app.game.share_limit')
          : t('app.common.error'),
      );
    }
  };
  const resign = async (): Promise<void> => {
    if (
      await confirmDialog(t('app.game.resign_confirm'), {
        confirmLabel: t('app.game.resign'),
        danger: true,
      })
    )
      await action('resign');
  };
  const abort = async (): Promise<void> => {
    if (
      await confirmDialog(t('app.game.abort_confirm'), {
        confirmLabel: t('app.game.abort'),
        danger: true,
      })
    )
      await action('abort');
  };
  const rematch = async (): Promise<void> => {
    try {
      await client.post(`/api/games/${gameId}/rematch`, {});
      toast(t('app.game.rematch_sent'));
      router.replace({ name: 'lobby', groupId: dto.group.id });
    } catch {
      toast(t('app.common.error'));
    }
  };
  const analyse = (): void => {
    const url = dto.lichessUrl ?? dto.analysisUrl;
    if (url) tg.openLink(url);
  };
  const pgn = (): void => {
    const url = new URL(
      client.url(`/api/games/${gameId}/pgn`, { token: client.token ?? '' }),
      window.location.origin,
    ).toString();
    if (!tg.downloadFile(url, `${gameId}.pgn`)) tg.openLink(url);
  };

  const orientation = store.orientation.value;
  const top: Colour = orientation === 'white' ? 'black' : 'white';
  const offer = dto.drawOffer;
  const myColour = isPlayer ? (dto.viewerRole as Colour) : null;
  const canOffer = isPlayer && dto.status === 'active' && !offer;
  const offerFromOpponent = isPlayer && offer !== null && offer.by !== myColour;
  const claimable =
    isPlayer && dto.status === 'active' && (dto.claims.threefold || dto.claims.fiftyMove);
  const busy = moveState.kind !== 'idle';

  return (
    <div class="game">
      <PlayerBar dto={dto} colour={top} now={now} />
      <Board store={store} onMove={onDrop} onReady={(adapter) => (adapterRef.current = adapter)}>
        {promotion ? (
          <div
            class="promotion"
            style={promotionOverlayStyle(promotion.dest, orientation)}
            role="dialog"
            aria-label={t('app.game.promotion')}
          >
            {promotionPieces().map((piece) => (
              <button
                key={piece}
                data-promote={piece}
                class={`cg-wrap ${PIECE_CLASS[piece]} ${dto.viewerRole === 'black' ? 'black' : 'white'}`}
                onClick={() => promote(piece)}
              >
                {h('piece', {
                  class: `${PIECE_CLASS[piece]} ${dto.viewerRole === 'black' ? 'black' : 'white'}`,
                })}
              </button>
            ))}
            <button data-promote="cancel" onClick={() => promote(null)}>
              ✕
            </button>
          </div>
        ) : null}
      </Board>
      <PlayerBar dto={dto} colour={orientation} now={now} />
      <MoveList store={store} />
      {dto.status === 'finished' ? (
        <div class="replay-controls">
          <button
            class="btn secondary"
            data-action="prev"
            onClick={() => store.viewPly(store.position.value.ply - 1)}
          >
            ◀
          </button>
          <input
            type="range"
            min={0}
            max={dto.plyCount}
            value={store.position.value.ply}
            onInput={(event) => store.viewPly(Number(event.currentTarget.value))}
          />
          <button
            class="btn secondary"
            data-action="next"
            onClick={() => store.viewPly(store.position.value.ply + 1)}
          >
            ▶
          </button>
        </div>
      ) : null}
      {dto.status === 'finished' ? (
        <div class="banner result">
          <span class="grow">
            {dto.voided ? t('app.game.voided') : resultForViewer(dto)}
            {reasonForViewer(dto) ? ` · ${reasonForViewer(dto)}` : ''}
            {ratingChangeFor(dto) ? ` · ${ratingChangeFor(dto)}` : ''}
          </span>
        </div>
      ) : null}
      {offerFromOpponent && dto.status === 'active' ? (
        <div class="banner">
          <span class="grow">{t('app.game.draw_offer_from', { name: dto[offer!.by].name })}</span>
          <button class="btn" data-action="accept-draw" onClick={() => void action('draw/accept')}>
            {t('button.accept')}
          </button>
          <button
            class="btn secondary"
            data-action="decline-draw"
            onClick={() => void action('draw/decline')}
          >
            {t('button.decline')}
          </button>
        </div>
      ) : null}
      {isPlayer && offer && offer.by === myColour && dto.status === 'active' ? (
        <div class="banner">{t('app.game.draw_offered')}</div>
      ) : null}
      {inPageCancel && moveState.kind === 'pendingConfirm' ? (
        <div class="inline-main">
          <button
            class="btn secondary block"
            data-action="cancel-move"
            onClick={() => dispatch({ type: 'cancel' })}
          >
            {t('app.game.cancel')}
          </button>
        </div>
      ) : null}
      <div class="toolbar">
        <button class="btn secondary" data-action="share" onClick={() => void share()}>
          {t('app.game.share')}
        </button>
        {dto.status === 'active' && canOffer ? (
          <button
            class="btn secondary"
            data-action="offer-draw"
            disabled={busy}
            onClick={() => void action('draw/offer')}
          >
            {t('app.game.offer_draw')}
          </button>
        ) : null}
        {claimable ? (
          <button
            class="btn secondary"
            data-action="claim-draw"
            disabled={busy}
            onClick={() => void action('draw/claim')}
          >
            {t('app.game.claim_draw')}
          </button>
        ) : null}
        {isPlayer && dto.status === 'active' && dto.plyCount < 2 ? (
          <button
            class="btn danger"
            data-action="abort"
            disabled={busy}
            onClick={() => void abort()}
          >
            {t('app.game.abort')}
          </button>
        ) : null}
        {isPlayer && dto.status === 'active' ? (
          <button
            class="btn danger"
            data-action="resign"
            disabled={busy}
            onClick={() => void resign()}
          >
            {t('app.game.resign')}
          </button>
        ) : null}
        {!isPlayer ? (
          <button class="btn secondary" data-action="flip" onClick={() => store.flip()}>
            {t('app.game.flip')}
          </button>
        ) : null}
        {dto.status === 'finished' && isPlayer && !dto.voided ? (
          <button class="btn" data-action="rematch" onClick={() => void rematch()}>
            {t('app.game.rematch')}
          </button>
        ) : null}
        {dto.status === 'finished' && (dto.lichessUrl || dto.analysisUrl) ? (
          <button class="btn secondary" data-action="analyse" onClick={analyse}>
            {t('app.game.analyse')}
          </button>
        ) : null}
        {dto.status === 'finished' ? (
          <button class="btn secondary" data-action="pgn" onClick={pgn}>
            {t('app.game.pgn')}
          </button>
        ) : null}
        {dto.status === 'finished' && session.value?.launchedFrom?.kind === 'game' ? (
          <button class="btn secondary" data-action="done" onClick={() => tg.close()}>
            {t('app.game.done')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
