import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Fetch } from '../apple/egress.js';
import { HostPlayer, PlayerFailure, PlayerUnavailable } from './host.js';

/** The host's answer to a command, or a network failure. */
function host(reply: (sent: { url: string; body: any; auth: string }) => Response | Error) {
  const sent: Array<{ url: string; body: any; auth: string }> = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const entry = {
      url: String(url),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      auth: (init.headers as Record<string, string>)?.Authorization ?? '',
    };
    sent.push(entry);
    const out = reply(entry);
    if (out instanceof Error) throw out;
    return out;
  }) as unknown as Fetch;
  return { player: new HostPlayer(fetchFn, 'http://127.0.0.1:4000', 'internal', 'apple'), sent };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('a command goes to the host with the service, the op and the internal token', async () => {
  const { player, sent } = host(() => json({ ok: true, result: { tracks: [] } }));

  const result = await player.call('search', { query: 'nairobi' }, 5_000);

  assert.deepEqual(result, { tracks: [] });
  assert.equal(sent[0].url, 'http://127.0.0.1:4000/api/v1/player/command');
  assert.equal(sent[0].auth, 'Bearer internal');
  assert.deepEqual(sent[0].body, { service: 'apple', op: 'search', args: { query: 'nairobi' }, timeout_ms: 5_000 });
});

test('a refusal the page gives is a PlayerFailure with the page\'s own code', async () => {
  const { player } = host(() => json({ ok: false, code: 'drm_refused', error: 'Apple refused the license.' }));
  await assert.rejects(
    player.call('play'),
    (e: Error) => e instanceof PlayerFailure && e.code === 'drm_refused' && /Apple refused/.test(e.message),
  );
});

test('the host\'s own reasons are PlayerUnavailable', async () => {
  for (const code of ['no_player', 'timeout', 'refused', 'player_replaced', 'player_gone']) {
    const { player } = host(() => json({ ok: false, code, error: `because ${code}` }));
    await assert.rejects(
      player.call('pause'),
      (e: Error) => e instanceof PlayerUnavailable && e.code === code,
      code,
    );
  }
});

test('an unreachable host is PlayerUnavailable, not a crash', async () => {
  const { player } = host(() => new TypeError('fetch failed'));
  await assert.rejects(player.call('pause'), (e: Error) => e instanceof PlayerUnavailable && e.code === 'host_unreachable');
});

test('a refused token and a server error are told apart', async () => {
  await assert.rejects(host(() => json({}, 401)).player.call('pause'), /did not accept this extension's token/);
  await assert.rejects(host(() => json({}, 500)).player.call('pause'), /answered 500/);
});

test('status reads this service\'s entry', async () => {
  const { player, sent } = host(() => json({ apple: { attached: true, configured: true }, tidal: { attached: false, configured: false } }));
  assert.deepEqual(await player.status(), { attached: true, configured: true });
  assert.equal(sent[0].url, 'http://127.0.0.1:4000/api/v1/player/status');
});

test('status is null when the host cannot be asked, or does not know the service', async () => {
  assert.equal(await host(() => new TypeError('down')).player.status(), null);
  assert.equal(await host(() => json({}, 401)).player.status(), null);
  assert.equal(await host(() => json({ tidal: { attached: true, configured: true } })).player.status(), null);
});
