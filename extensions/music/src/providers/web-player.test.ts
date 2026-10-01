import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PlayerFailure, PlayerUnavailable, type PlayerHost } from './player/host.js';
import { UnsupportedError, type MusicProvider, type TrackInfo } from './types.js';
import { WebPlayerProvider } from './web-player.js';

const nairobi = { id: '1001', kind: 'song', title: 'Nairobi', artist: 'Bensoul', album: 'Qwarantunes', duration_ms: 210_000 };
const cover = { id: '1002', kind: 'song', title: 'Nairobi', artist: 'Some Cover Band', album: 'Covers', duration_ms: 200_000 };

/** A player page that answers by op, and records what it was asked. */
function player(answers: Record<string, unknown | ((args: any) => unknown)> = {}) {
  const calls: Array<{ op: string; args: any }> = [];
  const host: PlayerHost = {
    async call(op: string, args: Record<string, unknown> = {}) {
      calls.push({ op, args });
      const a = answers[op];
      const out = typeof a === 'function' ? (a as (x: any) => unknown)(args) : a;
      if (out instanceof Error) throw out;
      return (out ?? {}) as never;
    },
    async status() {
      return { attached: true, configured: true };
    },
  };
  return { host, calls };
}

/** The fallback: records which calls it was given. */
function fallback() {
  const calls: string[] = [];
  const local = new Proxy({} as MusicProvider, {
    get: (_t, name: string) => {
      if (name === 'playRequest') return async () => (calls.push('playRequest'), 'Now playing track: From the Music app');
      if (name === 'capabilities') return { devices: true, queue: false, timeRange: false };
      return async (...args: unknown[]) => (calls.push(name), name === 'getNowPlaying' ? null : args.length ? undefined : undefined);
    },
  });
  return { local, calls };
}

const make = (host: PlayerHost, local: MusicProvider | null = null) =>
  new WebPlayerProvider({
    host,
    service: 'apple',
    label: 'Apple Music',
    local,
    linkToId: link => link.match(/[?&]i=(\d+)/)?.[1] ?? null,
  });

const unavailable = (code: any, message = 'nope') => new PlayerUnavailable(code, message);

// ── playing ──────────────────────────────────────────────────────────────────

test('a query is searched, then the best match is played, and the result names it', async () => {
  const { host, calls } = player({ search: { tracks: [cover, nairobi] } });

  const text = await make(host).playRequest({ query: 'Nairobi by Bensoul' });

  assert.deepEqual(calls.map(c => c.op), ['search', 'play']);
  assert.deepEqual(calls[1].args, { id: '1001', kind: 'song' }, 'the artist asked for, not the first hit');
  assert.match(text, /Now playing track: Nairobi by Bensoul \(Qwarantunes\)/);
  assert.match(text, /Other matches:\n2\. Nairobi by Some Cover Band/);
});

test('when nothing matches strictly, the top hit plays and is named from the result', async () => {
  const { host, calls } = player({ search: { tracks: [nairobi] } });
  const text = await make(host).playRequest({ query: 'something upbeat' });
  assert.deepEqual(calls[1].args, { id: '1001', kind: 'song' });
  assert.match(text, /Nairobi by Bensoul/);
});

test('no results says so and plays nothing', async () => {
  const { host, calls } = player({ search: { tracks: [] } });
  assert.match(await make(host).playRequest({ query: 'zzzz' }), /No results found for "zzzz"/);
  assert.deepEqual(calls.map(c => c.op), ['search']);
});

test('no query and no link resumes', async () => {
  const { host, calls } = player();
  assert.equal(await make(host).playRequest({}), 'Resumed playback');
  assert.deepEqual(calls.map(c => c.op), ['resume']);
});

test('a pasted link plays that song and reports what is playing', async () => {
  const { host, calls } = player({ state: { status: 'playing', track: nairobi } });
  const text = await make(host).playRequest({ uri: 'https://music.apple.com/ke/album/x/9?i=1001' });
  assert.deepEqual(calls[0], { op: 'play', args: { id: '1001', kind: 'song' } });
  assert.match(text, /Now playing track: Nairobi by Bensoul/);
});

test('a URI from an earlier result plays by its own kind', async () => {
  const { host, calls } = player({ state: { track: null } });
  await make(host).playRequest({ uri: 'apple:web:playlist:p.7' });
  assert.deepEqual(calls[0].args, { id: 'p.7', kind: 'playlist' });
});

test('something that is not a link for this service is refused plainly', async () => {
  const { host, calls } = player();
  assert.match(await make(host).playRequest({ uri: 'https://example.com/x' }), /does not look like a link to a song on Apple Music/);
  assert.equal(calls.length, 0);
});

// ── when the player cannot be used ───────────────────────────────────────────

test('with no player running, the Music app plays instead and the result says why', async () => {
  const { host } = player({ search: unavailable('no_player', 'The music player is not running.') });
  const { local, calls } = fallback();

  const text = await make(host, local).playRequest({ query: 'Nairobi' });

  assert.match(text, /The music player page could not be used \(The music player is not running\.\), so/);
  assert.match(text, /Music app was used instead/);
  assert.match(text, /From the Music app/);
  assert.deepEqual(calls, ['playRequest']);
});

test('a refused license falls back too, with Apple\'s reason in the text', async () => {
  const { host } = player({
    search: { tracks: [nairobi] },
    play: new PlayerFailure('drm_refused', 'Apple refused the playback license (MEDIA_LICENSE).'),
  });
  const { local } = fallback();
  const text = await make(host, local).playRequest({ query: 'Nairobi' });
  assert.match(text, /Apple refused the playback license/);
});

test('needing a sign-in falls back, and the reason names it', async () => {
  const { host } = player({ search: new PlayerFailure('needs_authorization', 'Sign in to Apple Music in the player window first.') });
  const { local } = fallback();
  assert.match(await make(host, local).playRequest({ query: 'x' }), /Sign in to Apple Music/);
});

test('the network policy refusing is not worked around by the fallback', async () => {
  const { host } = player({ search: unavailable('refused', 'network_mode is offline.') });
  const { local, calls } = fallback();
  await assert.rejects(make(host, local).playRequest({ query: 'x' }), /offline/);
  assert.deepEqual(calls, []);
});

test('a timeout is reported, not retried elsewhere: the song may have started', async () => {
  const { host } = player({ search: { tracks: [nairobi] }, play: unavailable('timeout', 'did not answer in time') });
  const { local, calls } = fallback();
  await assert.rejects(make(host, local).playRequest({ query: 'Nairobi' }), /did not answer in time/);
  assert.deepEqual(calls, []);
});

test('with no fallback, the failure is the answer', async () => {
  const { host } = player({ search: unavailable('no_player', 'The music player is not running.') });
  await assert.rejects(make(host).playRequest({ query: 'x' }), /not running/);
});

// ── transport ────────────────────────────────────────────────────────────────

test('each control is one command with its argument', async () => {
  const { host, calls } = player();
  const p = make(host);

  assert.equal(await p.pause(), 'Playback paused');
  assert.equal(await p.next(), 'Skipped to next track');
  assert.equal(await p.previous(), 'Went to previous track');
  assert.equal(await p.setVolume(150), 'Volume set to 100%');
  assert.equal(await p.setShuffle(true), 'Shuffle enabled');
  assert.equal(await p.seek(90_000), 'Jumped to 1:30');
  await p.setRepeat('track');
  await p.setRepeat('context');
  await p.setRepeat('off');

  assert.deepEqual(calls.map(c => [c.op, c.args]), [
    ['pause', {}], ['next', {}], ['previous', {}],
    ['volume', { percent: 100 }], ['shuffle', { enabled: true }], ['seek', { position_ms: 90_000 }],
    ['repeat', { mode: 'one' }], ['repeat', { mode: 'all' }], ['repeat', { mode: 'off' }],
  ]);
});

test('pausing with no player pauses the Music app', async () => {
  const { host } = player({ pause: unavailable('no_player') });
  const { local, calls } = fallback();
  assert.equal(await make(host, local).pause(), 'Playback paused');
  assert.deepEqual(calls, ['pause']);
});

// ── what is playing, and the user's things ───────────────────────────────────

test('now playing is the page\'s state, in the shape the status tool reads', async () => {
  const { host } = player({ state: { status: 'playing', track: nairobi, position_ms: 12_000, volume: 40 } });
  const now = (await make(host).getNowPlaying()) as TrackInfo;
  assert.equal(now.name, 'Nairobi');
  assert.equal(now.uri, 'apple:web:song:1001');
  assert.equal(now.is_playing, true);
  assert.equal(now.progress_ms, 12_000);
  assert.equal(now.volume_percent, 40);
});

test('nothing playing is null, and the queue is just the current song', async () => {
  const idle = player({ state: { status: 'idle', track: null } });
  assert.equal(await make(idle.host).getNowPlaying(), null);
  assert.deepEqual(await make(idle.host).getQueue(), []);

  const busy = player({ state: { status: 'playing', track: nairobi } });
  assert.equal((await make(busy.host).getQueue()).length, 1);
});

test('playlists become playable URIs, and playing one asks for its kind', async () => {
  const { host, calls } = player({ playlists: { playlists: [{ id: 'p.1', name: 'Road trip' }] } });
  const p = make(host);

  const [road] = await p.getPlaylists();
  assert.deepEqual([road.name, road.uri, road.is_own], ['Road trip', 'apple:web:playlist:p.1', true]);

  await p.play(road.uri);
  assert.deepEqual(calls.at(-1), { op: 'play', args: { kind: 'playlist', id: 'p.1' } });
});

test('a song is queued next by its own id', async () => {
  const { host, calls } = player();
  await make(host).addToQueue('apple:web:song:1001');
  assert.deepEqual(calls[0], { op: 'enqueue', args: { kind: 'song', id: '1001', where: 'next' } });
  await assert.rejects(make(host).addToQueue('spotify:track:x'), UnsupportedError);
});

test('library reads ask for saved and recent', async () => {
  const { host, calls } = player({ library: { tracks: [nairobi] } });
  const p = make(host);
  assert.equal((await p.getSavedTracks(5))[0].name, 'Nairobi');
  await p.getRecentlyPlayed(7);
  assert.deepEqual(calls.map(c => c.args), [{ kind: 'saved', limit: 5 }, { kind: 'recent', limit: 7 }]);
});

test('what is played most comes from the Music app, and is unsupported without it', async () => {
  const { host } = player();
  const { local, calls } = fallback();
  await make(host, local).getTopTracks('medium_term', 5);
  assert.deepEqual(calls, ['getTopTracks']);
  await assert.rejects(make(host).getTopTracks('medium_term'), UnsupportedError);
});

test('the Music app\'s own tracks and playlists keep playing through the Music app', async () => {
  const { host, calls } = player();
  const { local, calls: localCalls } = fallback();
  await make(host, local).play('apple:library:PID-1');
  assert.deepEqual(calls, [], 'never sent to the player page');
  assert.deepEqual(localCalls, ['play']);
});

// ── shape ────────────────────────────────────────────────────────────────────

test('it advertises a queue and no devices or time range', () => {
  const { host } = player();
  assert.deepEqual(make(host).capabilities, { devices: false, queue: true, timeRange: false });
});

test('its wording names its own service, and Spotify only to say the assistant cannot control it', () => {
  const { host } = player();
  const text = JSON.stringify(make(host).describe);
  assert.match(text, /Apple Music/);
  assert.match(text, /say the assistant cannot control Spotify, and do not play it on Apple Music instead/);
  assert.equal(text.match(/Spotify/g)?.length, 2, 'Spotify is named in that one sentence and nowhere else');
});

test('a service is only a name: a second one needs no new code here', async () => {
  const { host, calls } = player({ search: { tracks: [{ ...nairobi, id: '55' }] } });
  const tidal = new WebPlayerProvider({ host, service: 'apple', label: 'Tidal', local: null });
  const text = await tidal.playRequest({ query: 'Nairobi' });
  assert.equal(tidal.name, 'Tidal');
  assert.match(tidal.describe.play!, /Tidal/);
  assert.equal(calls[1].args.id, '55');
  assert.match(text, /Now playing track/);
});
