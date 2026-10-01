import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultStorefront, ItunesSearch, musicAppUrl, songIdFromLink } from './catalog.js';
import { EgressGate, EgressRefused, type Fetch } from './egress.js';

/** Every network call goes through a fake `fetch`, so nothing here leaves the machine. */

interface Sent { url: string; method: string; headers: Record<string, string>; body?: string }

function fakeFetch(handler: (sent: Sent) => Response | Promise<Response>): { fetch: Fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const entry: Sent = {
      url: String(url),
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : undefined,
    };
    sent.push(entry);
    return handler(entry);
  }) as unknown as Fetch;
  return { fetch: fetchFn, sent };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const HOST = 'http://127.0.0.1:4000';

// ── EgressGate ───────────────────────────────────────────────────────────────

test('an allowed call passes and is reported to the host with its extension name', async () => {
  const { fetch, sent } = fakeFetch(() => json({ allowed: true }));
  await new EgressGate(fetch, HOST, 'internal').allow('https://itunes.apple.com/search?term=x');

  assert.equal(sent[0].url, `${HOST}/api/v1/extension/egress`);
  assert.equal(sent[0].headers.Authorization, 'Bearer internal');
  assert.deepEqual(JSON.parse(sent[0].body!), {
    url: 'https://itunes.apple.com/search?term=x', method: 'GET', extension: 'music',
  });
});

test('a refusal carries the host\'s own explanation', async () => {
  const { fetch } = fakeFetch(() => json({ allowed: false, reason: 'Offline mode refuses itunes.apple.com.' }));
  await assert.rejects(
    new EgressGate(fetch, HOST, 'internal').allow('https://itunes.apple.com/search'),
    (err: Error) => err instanceof EgressRefused && /Offline mode/.test(err.message),
  );
});

test('an unreachable host does not silence the extension', async () => {
  const fetch = (async () => { throw new TypeError('fetch failed'); }) as unknown as Fetch;
  await new EgressGate(fetch, HOST, 'internal').allow('https://itunes.apple.com/search');
});

test('a host that does not know the route does not silence the extension either', async () => {
  const { fetch } = fakeFetch(() => json({ error: 'not found' }, 404));
  await new EgressGate(fetch, HOST, 'internal').allow('https://itunes.apple.com/search');
});

test('with no internal token there is no host to ask', async () => {
  const { fetch, sent } = fakeFetch(() => json({ allowed: false }));
  await new EgressGate(fetch, HOST, '').allow('https://itunes.apple.com/search');
  assert.equal(sent.length, 0);
});

// ── catalog helpers ──────────────────────────────────────────────────────────

test('a song id comes out of every link shape Apple uses', () => {
  assert.equal(songIdFromLink('https://music.apple.com/ke/album/nairobi/999?i=1001&uo=4'), '1001');
  assert.equal(songIdFromLink('https://music.apple.com/us/song/nairobi/1001'), '1001');
  assert.equal(songIdFromLink('music://music.apple.com/ke/album/nairobi/999?i=1001'), '1001');
  assert.equal(songIdFromLink('https://example.com/?i=5'), null);
  assert.equal(songIdFromLink('https://music.apple.com/ke/album/nairobi/999'), null);
});

test('a page link opens in the Music app, not the browser', () => {
  assert.equal(musicAppUrl('https://music.apple.com/ke/album/x/1?i=2'), 'music://music.apple.com/ke/album/x/1?i=2');
});

test('a URL that is not an Apple page is never handed to the Music app', () => {
  assert.equal(musicAppUrl('https://evil.example/x'), null);
  assert.equal(musicAppUrl('https://music.apple.com.evil.example/x'), null);
  assert.equal(musicAppUrl('file:///etc/passwd'), null);
  assert.equal(musicAppUrl('javascript:alert(1)'), null);
});

test('the store comes from the setting, else the machine\'s region, else US', () => {
  assert.equal(defaultStorefront('KE', 'en-US'), 'ke');
  assert.equal(defaultStorefront(undefined, 'en-KE'), 'ke');
  assert.equal(defaultStorefront('', 'en_GB'), 'gb');
  assert.equal(defaultStorefront(undefined, 'en'), 'us');
  assert.equal(defaultStorefront('nonsense', 'fr-FR'), 'fr');
});

// ── ItunesSearch ─────────────────────────────────────────────────────────────

const allowAll = new EgressGate((async () => json({ allowed: true })) as unknown as Fetch, HOST, 'internal');

test('a search asks for songs in the right store, with "by" folded into the term', async () => {
  const { fetch, sent } = fakeFetch(() => json({ results: [] }));
  await new ItunesSearch(fetch, allowAll, 'ke').searchSongs("Marvin's Room by Drake", 5);

  const url = new URL(sent[0].url);
  assert.equal(url.hostname, 'itunes.apple.com');
  assert.equal(url.searchParams.get('term'), "Marvin's Room Drake");
  assert.equal(url.searchParams.get('entity'), 'song');
  assert.equal(url.searchParams.get('country'), 'ke');
});

test('only songs come back, whatever else the index returns', async () => {
  const { fetch } = fakeFetch(() => json({
    results: [
      { kind: 'song', trackId: 1, trackName: 'Nairobi', artistName: 'Bensoul', collectionName: 'Q', trackTimeMillis: 1000, trackViewUrl: 'u' },
      { kind: 'music-video', trackId: 2, trackName: 'Nairobi (Video)' },
      { kind: 'song', trackName: 'no id' },
    ],
  }));
  const songs = await new ItunesSearch(fetch, allowAll, 'us').searchSongs('Nairobi', 5);
  assert.deepEqual(songs.map(s => s.id), ['1']);
});

test('a refused egress stops the search before anything is sent', async () => {
  const refusing = new EgressGate((async () => json({ allowed: false, reason: 'no' })) as unknown as Fetch, HOST, 'internal');
  const { fetch, sent } = fakeFetch(() => json({ results: [] }));

  await assert.rejects(new ItunesSearch(fetch, refusing, 'us').searchSongs('x', 5), EgressRefused);
  assert.equal(sent.length, 0);
});

test('rate limiting is explained', async () => {
  const { fetch } = fakeFetch(() => json({}, 429));
  await assert.rejects(new ItunesSearch(fetch, allowAll, 'us').searchSongs('x', 5), /rate limiting/);
});
