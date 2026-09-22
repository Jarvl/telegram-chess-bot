import {
  ChallengeDtoSchema,
  GROUP_SETTINGS_DEFAULTS,
  PlayersPickerDtoSchema,
  t,
  TIME_PER_MOVE_OPTIONS,
  timePerMoveLabel,
  type ChallengeRequest,
  type ColourChoice,
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
  const [timePerMove, setTimePerMove] = useState<TimePerMove>(defaults.defaultTimePerMove);
  const [colour, setColour] = useState<ColourChoice>('random');
  const [rated, setRated] = useState(defaults.ratedDefault);
  const [sending, setSending] = useState(false);

  const ready = opponentId !== undefined && !sending;
  const submit = useMemo(
    () => async () => {
      if (opponentId === undefined) return;
      setSending(true);
      const body: ChallengeRequest = { opponentId, timePerMove, colour, rated };
      try {
        await client.post(`/api/groups/${props.groupId}/challenges`, body, ChallengeDtoSchema);
        toast(t('app.new.sent'));
        router.replace({ name: 'lobby', groupId: props.groupId });
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
    [client, router, props.groupId, opponentId, timePerMove, colour, rated],
  );
  const inPage = useMainButton({
    text: t('app.new.send'),
    onClick: () => void submit(),
    enabled: ready,
    progress: sending,
  });

  if (players.error) return <ErrorScreen onRetry={() => void players.reload()} />;
  if (!players.data) return <Loading />;

  return (
    <div class="screen">
      <h1 class="title">{t('app.new.title')}</h1>
      <div class="section">{t('app.new.opponent')}</div>
      <div class="list">
        {players.data.players.map((player) => (
          <button
            key={player.id}
            class="row"
            data-opponent={player.id}
            aria-pressed={opponentId === player.id ? 'true' : 'false'}
            onClick={() => setOpponentId(player.id)}
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
            onClick={() => setOpponentId(null)}
          >
            <span class="grow primary">{t('app.new.open_challenge')}</span>
            {opponentId === null ? <span class="badge">✓</span> : null}
          </button>
        ) : null}
      </div>
      {players.data.players.length === 0 ? <p class="hint">{t('app.new.no_players')}</p> : null}
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
          <Switch checked={rated} onChange={setRated} data-rated="" label={t('app.new.rated')} />
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
