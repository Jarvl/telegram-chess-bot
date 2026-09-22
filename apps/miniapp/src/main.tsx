import { render } from 'preact';
import { createApiClient } from './api/client';
import { boot, relaunch } from './boot';
import { Router } from './router';
import { createTg } from './tg/webapp';
import { App } from './ui/App';
import { AppProvider, type AppContextValue } from './ui/context';
import './styles.css';

const tg = createTg();
const router = new Router(tg);
const app: AppContextValue = {
  tg,
  router,
  prefetched: {},
  client: createApiClient({ onUnauthorized: () => relaunch(app) }),
};

render(
  <AppProvider value={app}>
    <App />
  </AppProvider>,
  document.getElementById('app')!,
);

void boot(app);
