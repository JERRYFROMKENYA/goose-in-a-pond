import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Fetch } from './apple/egress.js';
import { createProvider } from './index.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const host = (reply: () => Response | Error): Fetch =>
  (async () => {
    const out = reply();
    if (out instanceof Error) throw out;
    return out;
  }) as unknown as Fetch;

test('a Spotify sign-in does not bring Spotify to the assistant: a Mac still gets Apple Music', async () => {
  const p = await createProvider(
    { SPOTIFY_ACCESS_TOKEN: 't', GIAP_INTERNAL_TOKEN: 'x' },
    'darwin',
    host(() => json({ apple: { attached: false, configured: false } })),
  );
  assert.equal(p?.id, 'apple');
});

test('a household that chose Spotify gets no provider, and the host is not asked', async () => {
  const p = await createProvider({ MUSIC_SERVICE: 'spotify' }, 'darwin', host(() => new Error('not asked')));
  assert.equal(p, null);
});

test('with the Music app chosen, the page is never used, even when a key is set up', async () => {
  const p = await createProvider(
    { MUSIC_PLAYER: 'app', GIAP_INTERNAL_TOKEN: 'x' },
    'darwin',
    host(() => new Error('not asked')),
  );
  assert.deepEqual(p?.capabilities, { devices: true, queue: false, timeRange: false });
});

test('off a Mac there is no provider, and the host is not even asked', async () => {
  const p = await createProvider({ SPOTIFY_ACCESS_TOKEN: 't' }, 'linux', host(() => new Error('not asked')));
  assert.equal(p, null);
});

test('Apple Music plays through the music player page once a key is set up', async () => {
  const p = await createProvider({ GIAP_INTERNAL_TOKEN: 'x' }, 'darwin', host(() => json({ apple: { attached: true, configured: true } })));
  assert.equal(p?.id, 'apple');
  assert.deepEqual(p?.capabilities, { devices: false, queue: true, timeRange: false });
});

test('with no key, Apple Music plays through the Music app', async () => {
  const p = await createProvider({ GIAP_INTERNAL_TOKEN: 'x' }, 'darwin', host(() => json({ apple: { attached: false, configured: false } })));
  assert.deepEqual(p?.capabilities, { devices: true, queue: false, timeRange: false });
});

test('with the host unreachable, Apple Music plays through the Music app', async () => {
  const p = await createProvider({}, 'darwin', host(() => new TypeError('connection refused')));
  assert.deepEqual(p?.capabilities, { devices: true, queue: false, timeRange: false });
});
