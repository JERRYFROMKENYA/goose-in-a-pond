import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MusicApp } from './music-app.js';
import { runAppleScript } from './osascript.js';

/**
 * Against the real Music app, which the fakes cannot stand in for: they passed while a position
 * read failed silently. `GIAP_MUSIC_LIVE=1` runs the read-only checks; `=play` also plays a
 * library track quietly for a few seconds, then pauses and restores the volume.
 */
const mode = process.env.GIAP_MUSIC_LIVE;
const readOnly = process.platform === 'darwin' && (mode === '1' || mode === 'play')
  ? false
  : 'set GIAP_MUSIC_LIVE=1 on a Mac with the Music app';
const audible = process.platform === 'darwin' && mode === 'play'
  ? false
  : 'set GIAP_MUSIC_LIVE=play to play a track';

const app = new MusicApp(runAppleScript);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('state answers with numbers', { skip: readOnly }, async () => {
  const state = await app.state();
  assert.ok(Number.isFinite(state.volume));
  assert.ok(Number.isFinite(state.position_s));
  if (state.track) {
    assert.ok(state.track.pid.length > 0);
    assert.ok(state.position_s <= state.track.duration_s + 1, 'position lies within the track');
  }
});

test('playlists come back in one bulk read, not one round trip each', { skip: readOnly }, async () => {
  const started = Date.now();
  const playlists = await app.playlists();
  assert.ok(Date.now() - started < 3000, 'took ' + (Date.now() - started) + ' ms');
  assert.ok(playlists.every(p => p.pid && p.name));
});

test('library listings carry the fields the tools read', { skip: readOnly }, async () => {
  for (const rows of [await app.favourites(), await app.mostPlayed()]) {
    assert.ok(rows.every(t => t.pid && Number.isFinite(t.played_count)));
  }
  const recent = await app.recentlyPlayed();
  assert.ok(recent.every(t => typeof t.age_s === 'number'), 'recent plays say how long ago');
});

test('AirPlay lists at least this computer', { skip: readOnly }, async () => {
  assert.ok((await app.airPlayDevices()).length >= 1);
});

test('a played track reports its position, and a seek moves it', { skip: audible }, async () => {
  const before = await app.state();
  const track = (await app.searchLibrary('love')).find(t => t.duration_s > 90);
  assert.ok(track, 'the library needs a track longer than 90 seconds to play');

  try {
    await app.setVolume(20);
    await app.playTrack(track.pid);
    await sleep(3000);
    const playing = await app.state();
    assert.equal(playing.state, 'playing');
    assert.equal(playing.track?.pid, track.pid);
    assert.ok(playing.position_s >= 1, 'position advances while playing, got ' + playing.position_s);

    await app.seek(30);
    await sleep(1000);
    assert.ok((await app.state()).position_s >= 29, 'a seek to 30 lands near 30');
  } finally {
    await app.transport('pause');
    await app.setVolume(before.volume);
  }
});
