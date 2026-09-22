import { PrefsSchema, t, type Prefs } from '@group-chess/shared';
import { z } from 'zod';
import { prefs } from '../../state/session';
import { useApp } from '../context';
import { Switch } from '../controls';
import { confirmDialog } from '../dialog';
import { toast } from '../toast';

const PrefsResponseSchema = z.object({ prefs: PrefsSchema, dmAllowed: z.boolean() });
const TOGGLES: {
  key: keyof Pick<Prefs, 'confirmMoves' | 'closeAfterMove' | 'notifications'>;
  label: string;
}[] = [
  { key: 'confirmMoves', label: 'app.settings.confirm_moves' },
  { key: 'closeAfterMove', label: 'app.settings.close_after_move' },
  { key: 'notifications', label: 'app.settings.notifications' },
];

export function Settings() {
  const { client, tg } = useApp();
  const current = prefs.value;
  const update = async (patch: Partial<Prefs>) => {
    const previous = prefs.value;
    prefs.value = { ...previous, ...patch };
    try {
      const response = await client.put('/api/me/prefs', { prefs: patch }, PrefsResponseSchema);
      prefs.value = response.prefs;
    } catch {
      prefs.value = previous;
      toast(t('app.common.error'));
    }
  };
  const remove = async () => {
    if (
      !(await confirmDialog(t('app.settings.delete_confirm'), {
        confirmLabel: t('app.settings.delete'),
        danger: true,
      }))
    )
      return;
    try {
      await client.del('/api/me');
      toast(t('app.settings.deleted'));
      tg.close();
    } catch {
      toast(t('app.common.error'));
    }
  };
  return (
    <div class="screen">
      <h1 class="title">{t('app.settings.title')}</h1>
      <div class="list">
        {TOGGLES.map(({ key, label }) => (
          <div class="field" key={key}>
            <span>{t(label as 'app.settings.confirm_moves')}</span>
            <Switch
              checked={current[key]}
              onChange={(value) => void update({ [key]: value })}
              data-pref={key}
              label={t(label as 'app.settings.confirm_moves')}
            />
          </div>
        ))}
      </div>
      <button class="btn danger block" data-action="delete" onClick={() => void remove()}>
        {t('app.settings.delete')}
      </button>
      <p class="hint">{t('app.settings.about')}</p>
    </div>
  );
}
