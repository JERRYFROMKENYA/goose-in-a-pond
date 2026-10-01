# GIAP Music Extension

MCP extension that lets the assistant play **Apple Music**, on a Mac. It never controls Spotify.

## Why not Spotify

Spotify's own rules forbid what the assistant would do with it. The
[Developer Policy](https://developer.spotify.com/policy) (III.3) forbids an app that lets people control
Spotify by voice, and the [Developer Terms](https://developer.spotify.com/terms) (IV.2.a.i) forbid
feeding Spotify content, metadata included, into an AI model, which every tool result would do. So
Spotify is played by hand instead: in the Spotify app, in the pond's Spotify player page (a browser tab,
built to Spotify's Web Playback SDK documentation), or with the app's own music controls. The Spotify
sign-in in this extension's settings is for those; the pond keeps the token and never gives it to this
extension. See [`docs/architecture/music-player.md`](../../docs/architecture/music-player.md).

## Choosing the service and the player

The extension's settings lead with two choices. **Music service**: Apple Music (the default), which the
assistant can play, or Spotify, which is played by hand. **Player**: the player page in your web browser
(the default), or the service's own app. With Apple Music, the page plays the whole catalog and the
Music app plays your library; with Spotify, the assistant has no music tools whichever player is chosen,
and says why. The extension reads the choices as `MUSIC_SERVICE` and `MUSIC_PLAYER`.

To sign in to Spotify, first register your own Spotify app (developer.spotify.com/dashboard; Spotify's
terms do not allow one app for every household) and paste its Client ID in the settings, which show the
redirect URI to add to it.

## Installation

Install from the GIAP Extensions marketplace with one click. Apple Music works at once through the
Music app; the first time, macOS asks whether Goose In A Pond may control Music. Add a MusicKit key, or
use Jarida's shared credentials, to play the whole catalog in the music player page. Every credential
is optional at install time.

On anything but a Mac the extension offers no tools, and tells the assistant why, so it can say so.

## Tools

`TOOLS` is built by `buildTools` in `src/tools.ts`, the only authority; a capability the provider lacks
is left out rather than advertised and refused.

| Tool | What it does | Notes |
|---|---|---|
| `play` | Play a song or playlist, or a pasted Apple Music link; resume with no arguments | `when: next` needs a queue: the player page has one, the Music app does not |
| `playlists` | List the user's playlists | |
| `library` | Favourite songs, most played, recently played | Lifetime play counts; no time range |
| `devices` | List AirPlay speakers, or switch to one | Through the Music app only; absent with the player page |
| `status` | What is playing now | |
| `control` | Pause, resume, next, previous, volume, shuffle, seek, repeat | |

## Apple Music

Apple Music plays through **the music player page** once an Apple Music key or the shared credentials
are available, and through the **Music app** otherwise, and whenever the page cannot be used. The
result says which it used.

| | Music player page | Music app |
|---|---|---|
| Plays | Any song in the Apple Music catalog, at once | Songs in your library; a catalog-only song is opened in Music and does **not** start |
| "Play next" | Yes | No queue to add to |
| Devices | The Mac's sound output (change it in Sound settings) | Music's AirPlay devices, through the `devices` tool |
| Needs | The page open in your browser, a sign-in there, and a click on it after the browser starts | macOS, and permission to control Music |

### Setting up the music player page

1. In the extension's settings press **Open the music player**. The page opens in your web browser;
   press **Sign in to Apple Music** there, with the Apple Account that has the subscription.
2. To use your own key instead of the shared credentials: join the
   [Apple Developer Program](https://developer.apple.com/programs/), create a **Media ID** and a
   **MusicKit key**, and enter the **Team ID**, **Key ID** and the `.p8` text under Developer settings.
   They are host-only: the pond signs short-lived developer tokens, so **the key is never given to this
   extension**.

If the browser has not been clicked since it started, the first play asks you to press Play on the page
once: browsers only let a page make sound after a click on it.

### Music app notes

- The scripts read Music's own dictionary (`sdef /System/Applications/Music.app`); favourites use the
  raw code `pLov`, since the property was `loved` before it was `favorited` and only the code stayed.
- A song played from the library carries on through the whole `Music` playlist, in library order, not
  through its album.
- Opening a catalog song's page in Music does not start it (checked on macOS 27).
- macOS 26 and later scope Music's commands (`com.apple.Music.playback`, `.library.read`,
  `.library.read-write`), so a permission prompt may name more than one.

### Network policy

The page asks the pond's `network_mode` before it loads Apple's script; the extension's own
public-search calls ask the pond first too (`POST /api/v1/extension/egress`). A pond that cannot be
reached does not block the extension, so a standalone `npm start` still works.

## Manual setup (development)

Nothing to configure: `npm start` on a Mac. The Music app must answer, so if a call hangs, look for a
macOS permission dialog or a sign-in window in Music. Calls give up after 20 seconds with that advice
rather than waiting.

## Testing

```bash
npm test            # unit tests: no network, no Music app
npm run typecheck
```

`GIAP_MUSIC_LIVE=1 npm test` also runs read-only checks against the real Music app;
`GIAP_MUSIC_LIVE=play` additionally plays a library track quietly for a few seconds. The fakes passed
while a position read was failing silently, so these are the ones that vouch for the scripts.

The script tests include a syntax compile of every AppleScript (macOS only). It cannot check that a term
exists in Music's dictionary, since an unknown name compiles as a variable; read the dictionary with
`sdef /System/Applications/Music.app` when adding one.

Test the MCP protocol handshake, and list the tools:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | npx tsx src/server.ts
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | npx tsx src/server.ts
```

## Requirements

- Node.js 22.12+ (see the repo's `.nvmrc`; `bash scripts/giap.sh node` sets it up)
- macOS, and see [Apple Music](#apple-music)
