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

/**
 * Exactly one opponent choice at a time. Replaces a pair of independently-settable
 * `opponentId`/`bot` fields, which let a human pick and a bot level coexist and left `submit`
 * choosing one of them arbitrarily.
 */
type Selection =
  | { kind: 'none' }
  | { kind: 'human'; id: string }
  | { kind: 'open' }
  | { kind: 'bot'; level: EngineLevel };

export function NewGame(props: { groupId: string; defaults?: LobbyDto['settings'] }) {
  const { client, router } = useApp();
  const defaults = props.defaults ?? GROUP_SETTINGS_DEFAULTS;
  const players = useResource(`players:${props.groupId}`, () =>
    client.get(`/api/groups/${props.groupId}/players`, PlayersPickerDtoSchema),
  );
  const [selection, setSelection] = useState<Selection>({ kind: 'none' });
  const [timePerMove, setTimePerMove] = useState<TimePerMove>(defaults.defaultTimePerMove);
  const [colour, setColour] = useState<ColourChoice>('random');
  const [rated, setRated] = useState(defaults.ratedDefault);
  const [sending, setSending] = useState(false);

  const ready = selection.kind !== 'none' && !sending;
  const submit = useMemo(
    () => async () => {
      if (selection.kind === 'none') return;
      setSending(true);
      try {
        if (selection.kind === 'bot') {
          const body: EngineGameRequest = { level: selection.level, colour, timePerMove };
          const game = await client.post(
            `/api/groups/${props.groupId}/engine-games`,
            body,
            GameDtoSchema,
          );
          router.replace({ name: 'game', gameId: game.id });
        } else {
          const opponentId = selection.kind === 'open' ? null : selection.id;
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
    [client, router, props.groupId, selection, timePerMove, colour, rated],
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
  // The picker DTO guarantees at least one level whenever the bot is offered; narrowing on the
  // first entry carries that guarantee into the types, so no non-null assertion is needed here.
  const firstLevel = botPicker?.levels[0];

  return (
    <div class="screen">
      <h1 class="title">{t('app.new.title')}</h1>
      <div class="section">{t('app.new.opponent')}</div>
      <div class="list">
        {botPicker && firstLevel ? (
          <button
            class="row"
            data-testid="opponent-bot"
            aria-pressed={selection.kind === 'bot' ? 'true' : 'false'}
            onClick={() => setSelection({ kind: 'bot', level: firstLevel })}
          >
            <span class="grow primary">{t('app.new.bot')}</span>
            {selection.kind === 'bot' ? <span class="badge">✓</span> : null}
          </button>
        ) : null}
        {players.data.players.map((player) => (
          <button
            key={player.id}
            class="row"
            data-opponent={player.id}
            aria-pressed={
              selection.kind === 'human' && selection.id === player.id ? 'true' : 'false'
            }
            onClick={() => setSelection({ kind: 'human', id: player.id })}
          >
            <span class="grow primary">{playerLabel(player)}</span>
            {selection.kind === 'human' && selection.id === player.id ? (
              <span class="badge">✓</span>
            ) : null}
          </button>
        ))}
        {defaults.allowOpenChallenges ? (
          <button
            class="row"
            data-opponent="open"
            aria-pressed={selection.kind === 'open' ? 'true' : 'false'}
            onClick={() => setSelection({ kind: 'open' })}
          >
            <span class="grow primary">{t('app.new.open_challenge')}</span>
            {selection.kind === 'open' ? <span class="badge">✓</span> : null}
          </button>
        ) : null}
      </div>
      {players.data.players.length === 0 ? <p class="hint">{t('app.new.no_players')}</p> : null}
      {selection.kind === 'bot' && botPicker ? (
        <>
          <div class="section">{t('app.new.bot_level')}</div>
          <div class="list">
            {botPicker.levels.map((level) => (
              <button
                key={level}
                class="row"
                data-testid={`bot-level-${level}`}
                aria-pressed={selection.level === level ? 'true' : 'false'}
                onClick={() => setSelection({ kind: 'bot', level })}
              >
                <span class="grow primary">{t(`app.level.${level}`)}</span>
                {selection.level === level ? <span class="badge">✓</span> : null}
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
            checked={selection.kind === 'bot' ? false : rated}
            onChange={setRated}
            disabled={selection.kind === 'bot'}
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
