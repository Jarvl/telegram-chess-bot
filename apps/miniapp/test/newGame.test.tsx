import { describe, expect, it } from 'vitest';
import { NewGame } from '../src/ui/screens/NewGame';
import { renderApp } from './support/render';

const players = {
  players: [{ id: '2', name: 'Bob', username: 'bob', rating: 1520, provisional: false }],
};
const challenge = {
  id: 'ChalAaaaaa',
  challenger: { id: '1', name: 'Alice', username: 'alice', rating: 1500, provisional: true },
  opponent: null,
  timePerMove: 28800,
  challengerColour: 'white',
  rated: false,
  status: 'pending',
  createdAt: '2026-09-20T10:00:00.000Z',
  expiresAt: '2026-09-21T10:00:00.000Z',
  viewer: { canAccept: false, canDecline: false, canCancel: true },
};

describe('NewGame', () => {
  it('posts the challenge with the chosen opponent, time, colour and rated flag', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      ({ method }) =>
        method === 'POST' ? { status: 200, body: challenge } : { status: 200, body: players },
    );
    await r.flush();
    expect(r.text()).toContain('Bob');
    await r.click('[data-opponent="2"]');
    await r.click('[data-time="28800"]');
    await r.click('[data-colour="white"]');
    await r.click('[data-rated]');
    window.__tg!.clickMain();
    await r.flush();
    const post = r.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/api/groups/GrOuPiDxYz/challenges');
    expect(post?.body).toEqual({
      opponentId: '2',
      timePerMove: 28800,
      colour: 'white',
      rated: false,
    });
    expect(r.app.router.current.value).toEqual({ name: 'lobby', groupId: 'GrOuPiDxYz' });
  });

  it('sends an open challenge with a null opponent and the group defaults', async () => {
    const r = renderApp(
      () => (
        <NewGame
          groupId="GrOuPiDxYz"
          defaults={{ defaultTimePerMove: 259200, ratedDefault: true, allowOpenChallenges: true }}
        />
      ),
      ({ method }) =>
        method === 'POST' ? { status: 200, body: challenge } : { status: 200, body: players },
    );
    await r.flush();
    await r.click('[data-opponent="open"]');
    window.__tg!.clickMain();
    await r.flush();
    expect(r.calls.find((c) => c.method === 'POST')?.body).toEqual({
      opponentId: null,
      timePerMove: 259200,
      colour: 'random',
      rated: true,
    });
  });

  it('explains an empty picker', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      () => ({ status: 200, body: { players: [] } }),
    );
    await r.flush();
    expect(r.text()).toContain('Reply to their message with /play');
  });
});
