import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chooseService, noMusicInstructions } from './select.js';

test('nothing chosen means Apple Music on the player page, on a Mac', () => {
  assert.deepEqual(chooseService('darwin'), {
    service: 'apple',
    player: 'page',
    reason: 'Apple Music, on the music player page',
  });
});

test('the Music app is used when it is the chosen player', () => {
  const choice = chooseService('darwin', { MUSIC_SERVICE: 'apple', MUSIC_PLAYER: 'app' });
  assert.equal(choice.service, 'apple');
  assert.equal(choice.player, 'app');
});

test('a household that chose Spotify gets no assistant service, whatever the player, and says why', () => {
  for (const player of ['page', 'app']) {
    const choice = chooseService('darwin', { MUSIC_SERVICE: 'spotify', MUSIC_PLAYER: player });
    assert.equal(choice.service, null);
    assert.match(choice.reason, /Spotify cannot be controlled by the assistant/);
    assert.match(noMusicInstructions(choice), /This household chose Spotify/);
    assert.match(noMusicInstructions(choice), /never controlled by the assistant/);
  }
});

test('off a Mac Apple Music is not available, and the words say so', () => {
  const choice = chooseService('linux', { MUSIC_SERVICE: 'apple' });
  assert.equal(choice.service, null);
  assert.match(noMusicInstructions(choice), /Apple Music needs a Mac/);
});

test('an answer the choice does not have is read as the default', () => {
  const choice = chooseService('darwin', { MUSIC_SERVICE: 'tidal', MUSIC_PLAYER: 'radio' });
  assert.equal(choice.service, 'apple');
  assert.equal(choice.player, 'page');
});
