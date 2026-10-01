import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AppleMusicProvider } from './apple-music.js';
import type { CatalogSong, CatalogSource } from './apple/catalog.js';
import type { LibraryTrack, MusicApp } from './apple/music-app.js';
import { UnsupportedError } from './types.js';

/** The decision tree behind `play`, with the Music app and Apple's APIs replaced by fakes. */

const nairobiLib: LibraryTrack = {
  pid: 'PID-NAIROBI', name: 'Nairobi', artist: 'Bensoul', album: 'Qwarantunes', duration_s: 210, played_count: 4,
};
const nairobiCat: CatalogSong = {
  id: '1001', name: 'Nairobi', artist: 'Bensoul', album: 'Qwarantunes', duration_ms: 210_000,
  url: 'https://music.apple.com/ke/album/nairobi/999?i=1001',
};

interface Fakes {
  library: LibraryTrack[];
  played: string[];
  opened: string[];
  searches: string[];
}

/** A library whose contents can change mid-test, as they do when a song syncs. */
function fakeApp(f: Fakes): MusicApp {
  const contains = (q: string) => f.library.filter(t => t.name.toLowerCase().includes(q.toLowerCase()));
  return {
    searchLibrary: async (q: string) => { f.searches.push(q); return contains(q); },
    playTrack: async (pid: string) => { f.played.push(pid); },
    playPlaylist: async (pid: string) => { f.played.push(`playlist:${pid}`); },
    openUrl: async (url: string) => { f.opened.push(url); },
    transport: async (c: string) => { f.played.push(`transport:${c}`); },
  } as unknown as MusicApp;
}

function setup(over: { library?: LibraryTrack[]; catalog?: CatalogSong[] | Error } = {}) {
  const f: Fakes = { library: over.library ?? [], played: [], opened: [], searches: [] };

  const catalog: CatalogSource = {
    searchSongs: async () => {
      if (over.catalog instanceof Error) throw over.catalog;
      return over.catalog ?? [];
    },
    lookupSong: async (id: string) => (Array.isArray(over.catalog) ? over.catalog.find(s => s.id === id) ?? null : null),
  };

  const provider = new AppleMusicProvider({ app: fakeApp(f), catalog });
  return { provider, f };
}

test('a song in the library plays without touching the catalog', async () => {
  const { provider, f } = setup({ library: [nairobiLib], catalog: new Error('must not be called') });

  const text = await provider.playRequest({ query: 'Nairobi by Bensoul' });

  assert.deepEqual(f.played, ['PID-NAIROBI']);
  assert.match(text, /Now playing track: Nairobi by Bensoul/);
});

test('a catalog-only song with no Apple Music key is opened, and the result says it is NOT playing', async () => {
  const { provider, f } = setup({ catalog: [nairobiCat] });

  const text = await provider.playRequest({ query: 'Nairobi by Bensoul' });

  assert.deepEqual(f.played, []);
  assert.deepEqual(f.opened, ['music://music.apple.com/ke/album/nairobi/999?i=1001']);
  assert.match(text, /NOT started playing/);
  assert.match(text, /app's own player/);
});

test('a song already in the library under the catalog spelling is found and played', async () => {
  const { provider, f } = setup({
    library: [{ ...nairobiLib, name: 'Nairobi (Remastered)' }],
    catalog: [nairobiCat],
  });

  await provider.playRequest({ query: 'that Bensoul song' });

  assert.deepEqual(f.played, ['PID-NAIROBI']);
});

test('a catalog failure is reported with its reason and plays nothing', async () => {
  const { provider, f } = setup({ catalog: new Error('The network policy refused itunes.apple.com.') });

  const text = await provider.playRequest({ query: 'Nairobi' });

  assert.deepEqual(f.played, []);
  assert.match(text, /could not be searched/);
  assert.match(text, /itunes\.apple\.com/);
});

test('no results says so', async () => {
  const { provider } = setup({ catalog: [] });
  assert.match(await provider.playRequest({ query: 'zzzz' }), /No results found for "zzzz"/);
});

test('a library hit lists no alternatives', async () => {
  const other: CatalogSong = { ...nairobiCat, id: '2', name: 'Nairobi Nights', artist: 'Someone' };
  const { provider } = setup({ library: [nairobiLib], catalog: [nairobiCat, other] });

  const text = await provider.playRequest({ query: 'Nairobi by Bensoul' });

  assert.ok(!text.includes('Other matches'));
});

test('no query and no link resumes', async () => {
  const { provider, f } = setup();
  assert.equal(await provider.playRequest({}), 'Resumed playback');
  assert.deepEqual(f.played, ['transport:play']);
});

test('a library uri plays that track', async () => {
  const { provider, f } = setup();
  await provider.playRequest({ uri: 'apple:library:PID-9' });
  assert.deepEqual(f.played, ['PID-9']);
});

test('an Apple Music link is looked up and played like a search hit', async () => {
  const { provider, f } = setup({ library: [nairobiLib], catalog: [nairobiCat] });

  const text = await provider.playRequest({ uri: 'https://music.apple.com/ke/album/nairobi/999?i=1001' });

  assert.deepEqual(f.played, ['PID-NAIROBI']);
  assert.match(text, /Nairobi/);
});

test('something that is not an Apple Music link is refused plainly', async () => {
  const { provider } = setup();
  assert.match(await provider.playRequest({ uri: 'https://example.com/x' }), /does not look like an Apple Music song link/);
});

test('there is no queue to add to', async () => {
  const { provider } = setup();
  await assert.rejects(provider.addToQueue(), UnsupportedError);
});

test('top artists add up plays across their tracks', async () => {
  const app = {
    mostPlayed: async () => [
      { pid: '1', name: 'a', artist: 'Sauti Sol', album: '', duration_s: 1, played_count: 5 },
      { pid: '2', name: 'b', artist: 'Bensoul', album: '', duration_s: 1, played_count: 7 },
      { pid: '3', name: 'c', artist: 'Sauti Sol, Nviiri', album: '', duration_s: 1, played_count: 4 },
    ],
  } as unknown as MusicApp;
  const provider = new AppleMusicProvider({ app, catalog: {} as never });

  const artists = await provider.getTopArtists('medium_term');

  assert.deepEqual(artists.map(a => a.name), ['Sauti Sol', 'Bensoul']);
});

test('recent plays come back newest first', async () => {
  const app = {
    recentlyPlayed: async () => [
      { pid: '1', name: 'old', artist: 'x', album: '', duration_s: 1, played_count: 1, age_s: 9000 },
      { pid: '2', name: 'new', artist: 'x', album: '', duration_s: 1, played_count: 1, age_s: 60 },
    ],
  } as unknown as MusicApp;
  const provider = new AppleMusicProvider({ app, catalog: {} as never });

  assert.deepEqual((await provider.getRecentlyPlayed()).map(t => t.name), ['new', 'old']);
});

test('AirPlay devices that are not available are not offered', async () => {
  const app = {
    airPlayDevices: async () => [
      { name: 'Kitchen', kind: 'HomePod', active: false, selected: false, available: true, volume: 30 },
      { name: 'Old TV', kind: 'AppleTV', active: false, selected: false, available: false, volume: 0 },
    ],
  } as unknown as MusicApp;
  const provider = new AppleMusicProvider({ app, catalog: {} as never });

  assert.deepEqual((await provider.getDevices()).map(d => d.name), ['Kitchen']);
});
