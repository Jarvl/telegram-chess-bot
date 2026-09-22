import { MeGroupsDtoSchema, t } from '@group-chess/shared';
import { useApp } from '../context';
import { useResource } from '../hooks';
import { ErrorScreen, Loading } from './Status';

export function Groups() {
  const { client, router, prefetched } = useApp();
  const initial = prefetched.groups;
  delete prefetched.groups;
  const groups = useResource(
    'groups',
    () => client.get('/api/me/groups', MeGroupsDtoSchema),
    initial,
  );
  if (groups.error) return <ErrorScreen onRetry={() => void groups.reload()} />;
  if (!groups.data) return <Loading />;
  return (
    <div class="screen">
      <h1 class="title">{t('app.groups.title')}</h1>
      {groups.data.groups.length === 0 ? <p class="hint">{t('app.groups.empty')}</p> : null}
      <div class="list">
        {groups.data.groups.map((group) => (
          <button
            key={group.id}
            class="row"
            data-group={group.id}
            onClick={() => router.push({ name: 'lobby', groupId: group.id })}
          >
            <span class="grow">
              <span class="primary">{group.title}</span>
              <span class="secondary">
                {t('app.groups.summary', { active: group.activeGames, yourMove: group.yourMove })}
              </span>
            </span>
            {group.yourMove > 0 ? <span class="badge">{group.yourMove}</span> : null}
          </button>
        ))}
      </div>
      <button
        class="btn secondary block"
        data-action="settings"
        onClick={() => router.push({ name: 'settings' })}
      >
        {t('app.settings.title')}
      </button>
    </div>
  );
}
