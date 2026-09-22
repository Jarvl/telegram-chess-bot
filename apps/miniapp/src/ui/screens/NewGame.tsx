import {
  ChallengeDtoSchema,
  GameDtoSchema,
  GROUP_SETTINGS_DEFAULTS,
  PlayersPickerDtoSchema,
  t,
  TIME_PER_MOVE_OPTIONS,
  timePerMoveLabel,
  type ChallengeRequest,
  type ColourChoice,
  type EngineGameRequest,
  type EngineLevel,
  type LobbyDto,
  type TimePerMove,
} from '@group-chess/shared';
import { useMemo, useState } from 'preact/hooks';
import { ApiError } from '../../api/client';
import { useApp } from '../context';
import { Segmented, Switch } from '../controls';
import { playerLabel } from '../format';
import { useMainButton, useResource } from '../hooks';
import { toast } from '../toast';
import { ErrorScreen, Loading } from './Status';

const TIME_VALUES: TimePerMove[] = [...TIME_PER_MOVE_OPTIONS, null];

export function NewGame(props: { groupId: string; defaults?: LobbyDto['settings'] }) {
  const { client, router } = useApp();
  const defaults = props.defaults ?? GROUP_SETTINGS_DEFAULTS;
  const players = useResource(`players:${props.groupId}`, () =>
    client.get(`/api/groups/${props.groupId}/players`, PlayersPickerDtoSchema),
  );
  const [opponentId, setOpponentId] = useState<string | null | undefined>(undefined);
  const [bot, setBot] = useState<EngineLevel | null>(null);
  const [timePerMove, setTimePerMove] = useState<TimePerMove>(defaults.defaultTimePerMove);
  const [colour, setColour] = useState<ColourChoice>('random');
  const [rated, setRated] = useState(defaults.ratedDefault);
  const [sending, setSending] = useState(false);

  const ready = (opponentId !== undefined || bot !== null) && !sending;
  const submit = useMemo(
    () => async () => {
      if (bot === null && opponentId === undefined) return;
      setSending(true);
      try {
        if (bot !== null) {
          const body: EngineGameRequest = { level: bot, colour, timePerMove };
          const game = await client.post(
            `/api/groups/${props.groupId}/engine-games`,
            body,
            GameDtoSchema,
          );
          router.replace({ name: 'game', gameId: game.id });
        } else if (opponentId !== undefined) {
          const body: ChallengeRequest = { opponentId, timePerMove, colour, rated };
          await client.post(`/api/groups/${props.groupId}/challenges`, body, ChallengeDtoSchema);
          toast(t('app.new.sent'));
          router.replace({ name: 'lobby', groupId: props.groupId });
        }
      } catch (error) {
        toast(
          error instanceof ApiError && error.code === 'network'
            ? t('app.common.offline')
            : t('app.common.error'),
        );
      } finally {
        setSending(false);
      }
    },
    [client, router, props.groupId, opponentId, bot, timePerMove, colour, rated],
  );
  const inPage = useMainButton({
    text: t('app.new.send'),
    onClick: () => void submit(),
    enabled: ready,
    progress: sending,
  });

  if (players.error) return <ErrorScreen onRetry={() => void players.reload()} />;
  if (!players.data) return <Loading />;
  const botPicker = players.data.bot;

  return (
    <div class="screen">
      <h1 class="title">{t('app.new.title')}</h1>
      <div class="section">{t('app.new.opponent')}</div>
      <div class="list">
        {botPicker ? (
          <button
            class="row"
            data-testid="opponent-bot"
            aria-pressed={bot !== null ? 'true' : 'false'}
            onClick={() => setBot(botPicker.levels[0]!)}
          >
            <span class="grow primary">{t('app.new.bot')}</span>
            {bot !== null ? <span class="badge">✓</span> : null}
          </button>
        ) : null}
        {players.data.players.map((player) => (
          <button
            key={player.id}
            class="row"
            data-opponent={player.id}
            aria-pressed={opponentId === player.id ? 'true' : 'false'}
            onClick={() => {
              setOpponentId(player.id);
              setBot(null);
            }}
          >
            <span class="grow primary">{playerLabel(player)}</span>
            {opponentId === player.id ? <span class="badge">✓</span> : null}
          </button>
        ))}
        {defaults.allowOpenChallenges ? (
          <button
            class="row"
            data-opponent="open"
            aria-pressed={opponentId === null ? 'true' : 'false'}
            onClick={() => {
              setOpponentId(null);
              setBot(null);
            }}
          >
            <span class="grow primary">{t('app.new.open_challenge')}</span>
            {opponentId === null ? <span class="badge">✓</span> : null}
          </button>
        ) : null}
      </div>
      {players.data.players.length === 0 ? <p class="hint">{t('app.new.no_players')}</p> : null}
      {botPicker ? (
        <>
          <div class="section">{t('app.new.bot_level')}</div>
          <div class="list">
            {botPicker.levels.map((level) => (
              <button
                key={level}
                class="row"
                data-testid={`bot-level-${level}`}
                aria-pressed={bot === level ? 'true' : 'false'}
                onClick={() => setBot(level)}
              >
                <span class="grow primary">{t(`app.level.${level}`)}</span>
                {bot === level ? <span class="badge">✓</span> : null}
              </button>
            ))}
          </div>
          <p class="hint">{t('app.new.bot_unrated')}</p>
        </>
      ) : null}
      <div class="section">{t('app.new.time')}</div>
      <div class="list">
        {TIME_VALUES.map((value) => (
          <button
            key={String(value)}
            class="row"
            data-time={value === null ? 'none' : value}
            aria-pressed={timePerMove === value ? 'true' : 'false'}
            onClick={() => setTimePerMove(value)}
          >
            <span class="grow primary">{timePerMoveLabel(value)}</span>
            {timePerMove === value ? <span class="badge">✓</span> : null}
          </button>
        ))}
      </div>
      <div class="section">{t('app.new.colour')}</div>
      <Segmented
        value={colour}
        onChange={setColour}
        options={[
          { value: 'white', label: t('colour.white'), 'data-colour': 'white' },
          { value: 'random', label: t('colour.random'), 'data-colour': 'random' },
          { value: 'black', label: t('colour.black'), 'data-colour': 'black' },
        ]}
      />
      <div class="list" style={{ marginTop: 16 }}>
        <div class="field">
          <span>{t('app.new.rated')}</span>
          <Switch
            checked={bot !== null ? false : rated}
            onChange={setRated}
            disabled={bot !== null}
            data-rated=""
            label={t('app.new.rated')}
          />
        </div>
      </div>
      {inPage ? (
        <div class="inline-main">
          <button class="btn block" disabled={!ready} onClick={() => void submit()}>
            {t('app.new.send')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
