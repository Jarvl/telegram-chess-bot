import { useApp } from './context';
import { Dialogs } from './dialog';
import { Game } from './screens/Game';
import { GroupSettings } from './screens/GroupSettings';
import { Groups } from './screens/Groups';
import { Lobby } from './screens/Lobby';
import { NewGame } from './screens/NewGame';
import { Player } from './screens/Player';
import { Settings } from './screens/Settings';
import { ErrorScreen, Loading, Locked, Reopen } from './screens/Status';
import { Toasts } from './toast';

function Screen() {
  const { router } = useApp();
  const route = router.current.value;
  switch (route.name) {
    case 'loading':
      return <Loading />;
    case 'error':
      return <ErrorScreen onRetry={() => window.location.reload()} />;
    case 'reopen':
      return <Reopen />;
    case 'locked':
      return <Locked group={route.group} />;
    case 'groups':
      return <Groups />;
    case 'lobby':
      return <Lobby key={route.groupId} groupId={route.groupId} tab={route.tab} />;
    case 'newGame':
      return <NewGame key={route.groupId} groupId={route.groupId} defaults={route.defaults} />;
    case 'game':
      return <Game key={route.gameId} gameId={route.gameId} />;
    case 'player':
      return (
        <Player
          key={`${route.groupId}:${route.userId}`}
          groupId={route.groupId}
          userId={route.userId}
        />
      );
    case 'settings':
      return <Settings />;
    case 'groupSettings':
      return <GroupSettings key={route.groupId} groupId={route.groupId} />;
  }
}

export function App() {
  return (
    <>
      <Screen />
      <Toasts />
      <Dialogs />
    </>
  );
}
