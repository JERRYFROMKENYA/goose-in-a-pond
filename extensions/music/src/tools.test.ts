import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AppleMusicProvider } from './providers/apple-music.js';
import { buildTools } from './tools.js';
import { redactSecrets } from './log.js';
import type { MusicProvider } from './providers/types.js';

function apple(): MusicProvider {
  return new AppleMusicProvider({ app: {} as never, catalog: {} as never });
}

const names = (p: MusicProvider) => buildTools(p).map(t => t.name);
const props = (p: MusicProvider, tool: string) =>
  Object.keys((buildTools(p).find(t => t.name === tool)!.inputSchema as { properties: object }).properties);

test('Apple Music offers six tools, the devices being AirPlay speakers', () => {
  assert.deepEqual(names(apple()), ['play', 'playlists', 'library', 'devices', 'status', 'control']);
  const devices = buildTools(apple()).find(t => t.name === 'devices')!;
  assert.match(devices.description, /AirPlay/);
});

test('Apple Music does not advertise a queue or a time range it cannot honour', () => {
  assert.ok(!props(apple(), 'play').includes('when'));
  assert.ok(!props(apple(), 'library').includes('time_range'));
});

test('no tool offers Spotify: it is named only to say the assistant cannot control it', () => {
  const text = JSON.stringify(buildTools(apple()));
  assert.equal(text.match(/Spotify/g)?.length, 2);
  assert.match(text, /if the user asks for Spotify, say the assistant cannot control Spotify/);
  assert.ok(!/spotify:/i.test(text), 'no Spotify URI is offered as input');
});

test('the Apple play description does not promise playback it cannot guarantee', () => {
  const play = buildTools(apple()).find(t => t.name === 'play')!;
  assert.match(play.description, /rather than assuming playback started/);
  assert.ok(!/keeps playing/i.test(play.description));
});

// ── log redaction for the new credentials ────────────────────────────────────

test('a developer token is redacted from log text', () => {
  const jwt = 'eyJhbGciOiJFUzI1NiIsImtpZCI6IkFCQ0QifQ.eyJpc3MiOiJURUFNIiwiaWF0IjoxfQ.MEUCIQDabcdefgh';
  assert.ok(!redactSecrets(`failed with ${jwt}`).includes('eyJ'));
});

test('a Music User Token header value is redacted', () => {
  const out = redactSecrets('{"Music-User-Token": "AbCdEf123456+/=xyz"}');
  assert.ok(!out.includes('AbCdEf123456'));
});
