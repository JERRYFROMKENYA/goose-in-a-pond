import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeName, pickSong, playlistMatchScore, splitTitleArtist } from './match.js';

const song = (name: string, artist: string) => ({ name, artist });

// ── playlist matching (moved from server.ts; behaviour must not change) ──────

test('an exact playlist name scores 1', () => {
  assert.equal(playlistMatchScore('Road Trip', 'road trip'), 1);
});

test('people run words together, so spaces do not matter', () => {
  assert.equal(playlistMatchScore('sautisol', 'Sauti Sol'), 0.95);
});

test('filler around a spoken name is ignored', () => {
  assert.equal(playlistMatchScore('my road trip playlist', 'Road Trip'), 1);
});

test('a partial word match never outranks containment', () => {
  assert.ok(playlistMatchScore('road', 'Road Trip') > playlistMatchScore('road work', 'Road Trip'));
});

test('normalizeName drops punctuation and emoji', () => {
  assert.equal(normalizeName("Marvin's  Room!"), 'marvin s room');
});

// ── splitTitleArtist ─────────────────────────────────────────────────────────

test('"X by Y" splits into title and artist', () => {
  assert.deepEqual(splitTitleArtist("Marvin's Room by Drake"), { title: "Marvin's Room", artist: 'Drake' });
});

test('a query with no "by" is all title', () => {
  assert.deepEqual(splitTitleArtist('jazz'), { title: 'jazz', artist: null });
});

test('a featured artist is dropped from the artist half', () => {
  assert.equal(splitTitleArtist('Nairobi by Bensoul feat. Nviiri').artist, 'Bensoul');
});

// ── pickSong ─────────────────────────────────────────────────────────────────

test('the requested song is picked by title and artist', () => {
  const pick = pickSong("Marvin's Room by Drake", [
    song("Marvin's Room", 'Drake'),
    song("Marvin's Room", 'Some Cover Band'),
  ]);
  assert.equal(pick?.artist, 'Drake');
});

test('a title prefix is not the song: Home is not Homecoming', () => {
  assert.equal(pickSong('Home', [song('Homecoming', 'Beyonce')]), null);
});

test('a remaster or live suffix still counts as the song', () => {
  const pick = pickSong('Nairobi', [song('Nairobi (Remastered)', 'Bensoul')]);
  assert.equal(pick?.name, 'Nairobi (Remastered)');
  assert.ok(pickSong('Nairobi', [song('Nairobi - Live', 'Bensoul')]));
});

test('the plain title beats the suffixed one', () => {
  const pick = pickSong('Nairobi', [song('Nairobi (Live)', 'Bensoul'), song('Nairobi', 'Bensoul')]);
  assert.equal(pick?.name, 'Nairobi');
});

test('a named artist must be among the song\'s artists', () => {
  assert.equal(pickSong('Nairobi by Sauti Sol', [song('Nairobi', 'Bensoul')]), null);
  assert.ok(pickSong('Nairobi by Bensoul', [song('Nairobi', 'Bensoul, Nviiri')]));
});

test('a mood is not a song title', () => {
  assert.equal(pickSong('something upbeat', [song('Upbeat', 'X')]), null);
});

test('no candidates, no pick', () => {
  assert.equal(pickSong('Nairobi', []), null);
});
