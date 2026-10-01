import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MusicApp,
  parseAirPlay,
  parsePlaylists,
  parseState,
  parseTracks,
  SCRIPTS,
} from './music-app.js';

/** Parsers and script shape only; nothing here needs Music.app running. */

test('a state line with a track parses every field', () => {
  const state = parseState('playing\t35\ttrue\tall\t72\tAB12\tNairobi\tBensoul\tQwarantunes\t210\t14\t');

  assert.equal(state.state, 'playing');
  assert.equal(state.volume, 35);
  assert.equal(state.shuffle, true);
  assert.equal(state.repeat, 'all');
  assert.equal(state.position_s, 72);
  assert.deepEqual(state.track, {
    pid: 'AB12',
    name: 'Nairobi',
    artist: 'Bensoul',
    album: 'Qwarantunes',
    duration_s: 210,
    played_count: 14,
  });
});

test('a stopped player has no track', () => {
  const state = parseState('stopped\t50\tfalse\toff\t0\t');
  assert.equal(state.track, null);
  assert.equal(state.state, 'stopped');
});

test('an unknown repeat mode reads as off', () => {
  assert.equal(parseState('playing\t1\tfalse\tsideways\t0\t').repeat, 'off');
});

test('track rows skip blanks and rows with no id', () => {
  const rows = parseTracks('A1\tOne\tArtist\tAlbum\t100\t3\t\n\n\tGhost\tX\tY\t1\t0\t\nB2\tTwo\tArtist\tAlbum\t200\t0\t\n');
  assert.deepEqual(rows.map(r => r.pid), ['A1', 'B2']);
});

test('the recent listing carries how long ago each track was played', () => {
  const [t] = parseTracks('A1\tOne\tArtist\tAlbum\t100\t3\t86400');
  assert.equal(t.age_s, 86400);
});

test('a name with a colon or unicode survives', () => {
  const [t] = parseTracks('A1\tMwana: Wa Nani?\tSauti Sol\tMidnight Train\t180\t1\t');
  assert.equal(t.name, 'Mwana: Wa Nani?');
});

test('playlists keep their kind', () => {
  const rows = parsePlaylists('P1\tRoad trip\tlong drives\t42\tuser playlist\nP2\tNew Music Mix\t\t25\tsubscription playlist\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].track_count, 42);
  assert.equal(rows[1].kind, 'subscription playlist');
});

test('AirPlay rows parse their flags', () => {
  const [d] = parseAirPlay('Kitchen\tHomePod\tfalse\ttrue\ttrue\t40');
  assert.deepEqual(d, {
    name: 'Kitchen', kind: 'HomePod', active: false, selected: true, available: true, volume: 40,
  });
});

test('user text reaches the script as an argument, never as source', async () => {
  const calls: Array<{ script: string; args: string[] }> = [];
  const app = new MusicApp(async (script, args) => {
    calls.push({ script, args });
    return '';
  });

  const hostile = 'x" & (do shell script "rm -rf ~") & "';
  await app.searchLibrary(hostile);
  await app.setAirPlayDevice(hostile);

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.args.includes(hostile), 'the text travels in argv');
    assert.ok(!call.script.includes('rm -rf'), 'and never in the script body');
  }
});

test('every script compiles', { skip: process.platform !== 'darwin' }, () => {
  // Syntax only: an unknown term compiles as a variable, so this cannot vouch for Music's dictionary.
  const dir = mkdtempSync(join(tmpdir(), 'giap-music-'));
  try {
    for (const [name, source] of Object.entries(SCRIPTS)) {
      const file = join(dir, `${name}.applescript`);
      writeFileSync(file, source);
      try {
        execFileSync('osacompile', ['-o', join(dir, `${name}.scpt`), file], { stdio: 'pipe' });
      } catch (err) {
        const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? String(err);
        assert.fail(`${name} does not compile: ${stderr}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
