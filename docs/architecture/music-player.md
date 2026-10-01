# The music player

A page the pond serves at `/player.html`, which runs in the person's own web browser, and the path the
`music` extension uses to drive it. It exists because the only route to a whole streaming catalog is
the service's own web SDK, and those SDKs need DRM. Nothing in this design names a service outside
its adapter.

**It runs in a browser tab, not in the app, on purpose.** Both services document their players the
same way: an ordinary web page in a mainstream browser, visible, started with a click. Apple's
MusicKit on the Web and Spotify's Web Playback SDK never mention Electron or any embedded browser,
and Electron's DRM (castlabs' build) carries a development signature that production licence servers
refuse: measured, Spotify answered every licence request with HTTP 500. A browser brings its own
verified DRM, so the licence question goes away. The page was built to follow the services'
documentation to the letter; where the product and the documentation disagree, the documentation won.

A service plugs in one of two ways, decided by where its control plane is:

| Style | Service | The page is | The extension |
|---|---|---|---|
| **Controller** | Apple Music (MusicKit is JavaScript-only) | Everything: search, queue, library, playback | `WebPlayerProvider`, over the bridge |
| **Speaker** | Spotify (a REST Web API drives playback) | One Connect device, named "Goose In A Pond", started and controlled by hand | Nothing: the assistant never controls Spotify. The app's music controls use Spotify's Web API through the pond |

Status, 2026-09-30: Apple Music is built to its documentation and ran in a browser tab against a
scratch pond, up to Apple's sign-in window (which opened). **Signing in and full playback have not
been run**: they need a person's Apple Account. Spotify is played by hand only; see "Spotify, by hand".

## Parts

| Part | Where | Job |
|---|---|---|
| Player page | `pond-desktop/src/player/` | `PlayerAdapter` (the service-agnostic interface, `types.ts`), one adapter per service (`adapters/`), the bridge (`bridge.ts`), the page's UI (`PlayerApp.tsx`). Built as its own page, `player.html`; `?service=apple` narrows it. Pairs with the pond as its own device over loopback. |
| Host bridge | `crates/pond-api/src/player.rs` | Holds who is attached and what is in flight; relays a command to the page and waits for its reply. One page per service: a newer one replaces the older. |
| Network check | `POST /api/v1/player/egress-policy` | The page asks, before it loads a service's script, whether the network setting allows it. The pond logs a yes as the player's request. |
| Developer token | `crates/pond-api/src/musickit.rs` | Signs Apple developer tokens (ES256) from the stored key, or fetches one from Jarida's credentials service, so the key stays out of every page and extension. |
| User token | `GET /api/v1/player/user-token` (`player.rs`) | Hands the paired page the person's Spotify access token, for Spotify's SDK. The token is `host_only`: the pond keeps it, and the Music extension never gets it. |
| Music controls | `pond-desktop/src/hub/primitives/NowPlaying.tsx`; `GET /api/v1/music/now-playing`, `POST /api/v1/music/control` | The app's own Spotify control, by hand: what is playing, drawn to Spotify's design guidelines, and play or pause through the Web API. |
| Music player row | `pond-desktop/src/sections/PlayerSignIn.tsx`, `signInView.ts` | In the Music extension's settings: **Open the music player** opens the page in the default browser (the shell's `open_external`), and the row says what the page last reported. |
| Spotify page | `pond-desktop/src/player/adapters/spotifyWebPlayback.ts` | Registers the page as a Spotify Connect device, armed by a click, and plays and pauses by hand. Opened with `?service=spotify` from the settings row or the music controls. |
| Extension | `extensions/music/src/providers/web-player.ts` | `WebPlayerProvider`: the extension's `MusicProvider` over the bridge, with the Music app as its fallback. Apple Music only. |

## Apple Music, by the documentation

What the adapter (`adapters/appleMusicKit.ts`) and the page do, and where each comes from. Sources:
[MusicKit on the Web v3](https://js-cdn.music.apple.com/musickit/v3/docs/index.html), the [Apple Developer
Program License Agreement](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/)
section 3.3.6(D), and the [Apple Music Identity Guidelines](https://marketing.services.apple/apple-music-identity-guidelines).

| Rule | Source | What the player does |
|---|---|---|
| Load Apple's hosted script with `async`; never bundle, merge or re-host it | Getting Started; DPLA 3.3.6(D) | A script tag for `js-cdn.music.apple.com/musickit/v3/musickit.js` |
| Touch `MusicKit` only after `musickitloaded` on `document`; `await MusicKit.configure({developerToken, app})`, which resolves to the instance | Getting Started; MusicKit reference | Exactly that; `app.name` is "Goose In A Pond", and the optional `build` is left out |
| `authorize()` opens Apple's sign-in, and resolves with nothing when it did not finish | User Authorization; Instance reference | Called first thing in the page's Sign in click, so the window may open; "did not finish" stays on the page until a sign-in does |
| `unauthorize()` signs out | User Authorization | A Sign out button on the page |
| Play with `setQueue({song | album | playlist: id, startPlaying: true})`; nothing back means this environment cannot play | Queue reference | Exactly that, reported as `unsupported` |
| `play()` can fail until the person has interacted with the page (`USER_INTERACTION_REQUIRED`) | Instance reference; MKError | Reported as `needs_interaction`: the assistant says to press Play on the page, and that click plays the queued song |
| Errors are MKErrors, the code in `errorCode` | MKError reference | Each documented code in words; a remedy only where Apple documents one |
| `drmUnsupported`: fell back to previews; `primaryPlayerDidChange`: another tab took over | Events reference | Both are said on the page and to the assistant |
| Artwork through `MusicKit.formatArtworkURL(artwork, w, h)` | Using Album Art | Exactly that, at 300 px, shown uncropped |
| The Passthrough API with the `{{storefrontId}}` token; `next` for more pages, with `limit` passed again | API reference; Paginated Requests | Search, playlists and the library that way |
| Full songs; playback the person starts; standard play, pause and skip controls | DPLA 3.3.6(D) | Music starts only when the person asks or presses Play; the page always shows the three controls once it can play; nothing plays on a schedule |
| Album art and song text only alongside playback | DPLA 3.3.6(D) | Shown in the now-playing view only |
| "Apple Music" written correctly, no badge unless linking | Identity Guidelines | The page says "Apple Music"; it shows no badge |
| No using Apple's content to train or improve an AI model | Apple Media Services Terms | Nothing here trains a model |

Apple documents no list of browsers. The page is tested in Chromium; Safari (FairPlay) and Chrome,
Edge or Firefox (Widevine) are the mainstream ones it is meant for.

## Signing in

The Music extension's settings show **Open the music player**. It opens `/player.html?service=apple`
from the pond in the default browser; outside the app it is an ordinary new tab. The page has the
**Sign in to Apple Music** button, because Apple's sign-in is a popup a browser only allows from a
click on that page, and the settings row reads the page's state (`GET /player/state`) every three
seconds until it says "Signed in". MusicKit keeps the sign-in in the browser, so a page reopened in
the same browser is signed in at once. A pond with no key and no shared credentials says so on the
page and offers no button.

Everything else is under a closed **Developer settings** disclosure in that dialog: the service picker
(`MUSIC_SERVICE`) and the fields for your own Apple key (Team ID, Key ID, private key).

## The protocol

Extension to host, `POST /api/v1/player/command` (internal token, loopback only):
`{service, op, args?, timeout_ms?}`. The host answers `{ok:true, result}` or
`{ok:false, code, error}` with status 200; status codes are for a malformed or unauthorised request.

| Code | Meaning | The provider |
|---|---|---|
| `no_player`, `player_gone`, `player_replaced` | No page is attached, or it closed or reopened mid-call | Falls back to the Music app, and says why |
| `refused` | `network_mode` refused a call that reaches the service | Reports it; a fallback would not be allowed either |
| `timeout` | The page took the command and did not answer | Reports it; the song may have started |
| `needs_authorization`, `not_ready`, `drm_refused` | The page answered no | Falls back, and says why |
| `needs_interaction` | The browser wants a click on the page first | Reports it: press Play on the page |
| `unsupported`, `bad_request`, `player_error` | The page answered no | Reports it |

Host to page, `GET /api/v1/player/events?service=` (server-sent events, the page's session token):
an `event: ready`, then `event: command` with `{id, service, op, args}`. Page to host:
`POST /player/reply` `{id, ok, result|error, code}` and `POST /player/state` `{service, state}`.

Ops: `state`, `search`, `play`, `enqueue`, `pause`, `resume`, `next`, `previous`, `seek`,
`volume`, `shuffle`, `repeat`, `playlists`, `library`, `device`. `authorize` is refused on purpose:
signing in needs a click on the page. Transport ops (`pause`, `next`, `volume`...) are never judged by
`network_mode`; ops that reach the service (`search`, `play`, `enqueue`, `playlists`, `library`) are.

## Security model

- **The page pairs as its own device**, over the loopback-only pairing endpoint, so it has to be opened
  on the pond's own computer, and its session lives in that browser's storage.
- **The network setting gates the script, not every request.** Before loading MusicKit the page asks
  `/player/egress-policy`, and under Offline it loads nothing and says why. Once MusicKit is loaded,
  the browser talks to Apple directly and the pond does not see those requests. In the old Electron
  window every request was filtered; a browser offers nothing like that to a page.
- **The signing key never leaves the pond.** `APPLE_MUSIC_TEAM_ID`, `_KEY_ID` and `_PRIVATE_KEY` are
  `host_only` secrets, withheld from every extension; the page asks `GET /api/v1/musickit/developer-token`
  with its own session. Extensions cannot mint tokens (their internal token is refused there).
- **Managed credentials.** A household with no key of its own uses `pondcredentials`
  (`docs/architecture/pondcredentials.md`); a stored local key always wins, and
  `POND_CREDENTIALS_URL=off` or `network_mode = offline` stops it.
- **Spotify's user token goes to the Spotify page**, since the SDK signs in as the person, and to
  nothing else: it is `host_only`, so the Music extension (the assistant's) never holds it. The page
  uses it for the SDK and for one Web API call, Transfer Playback, from its own Play here button.

## Spotify, by hand

Jarida's decision (2026-09-30, option B): Spotify plays in its own page, built to the Web Playback SDK
documentation, and is controlled by hand, never by the assistant. Spotify's
[Developer Policy](https://developer.spotify.com/policy) and [Developer Terms](https://developer.spotify.com/terms)
(version 10, both effective 15 May 2025), against what is built:

| Rule | Says | What GIAP does |
|---|---|---|
| Policy III.3 | Do not create a voice-enabled app that lets users control Spotify by voice | The assistant has no Spotify tool at all, in chat or voice: the Music extension is Apple Music only and tells the model why |
| Terms IV.2.a.i, Policy III.14 | No training an AI model on Spotify Content or otherwise ingesting it into one | No Spotify search result, track or playlist reaches the model; the token never reaches the extension (`host_only`) |
| Terms V.3 | Ask only for the data and scopes you need | Six scopes, down from twelve: the SDK's three, and reading and changing playback |
| Web Playback SDK | `onSpotifyWebPlaybackSDKReady` before the script; `Spotify.Player({name, getOAuthToken})`; every documented event; `connect()`; `activateElement()` from a click; `autoplay_failed` asks for it again | Exactly that. The page's **Play Spotify here** button calls `activateElement()` in the click, then the Web API's Transfer Playback to this device with `play: true` |
| Reference, `playback_error` | Loading or playing a track failed; no remedy given | The words are shown; nothing else is done (the earlier pause-on-error is gone) |
| Policy II.4, II.5; design guidelines | Attribute with Spotify's logo, link back, show cover art and metadata during playback; artwork uncropped with no overlay, 4 px corners; play and pause as the only control | The page and the music controls show the artwork as an image, the metadata as sent, **LISTEN ON SPOTIFY** linking to the track, play or pause only, and nothing Spotify's `disallows` forbids right now |
| Policy III.7 | "Do not permit any device or system to segue, mix, re-mix, or overlap any Spotify Content with any other audio content" | Spotify pauses while GIAP makes any sound, its wake ping, thinking tone and speech, and what a browser plays from `/tts`, then resumes where it was (below) |
| Policy III.5 | No product integrated with streams or content from another service | Accepted by Jarida with Apple Music in the same app; the two never share a queue, a view or a player |
| Terms VI.1; quota modes | The client ID is a Security Code kept from third parties; development mode is 5 allowlisted users | No client ID ships with GIAP. Each household registers its own Spotify app and pastes its Client ID (`SPOTIFY_CLIENT_ID`, host-only) in the Music extension's settings, which show the exact redirect URI to register; with none, signing in and every token refresh say so instead of trying |
| Design guidelines, logo | Spotify's official logo, unaltered, beside Spotify content | Spotify's own full logo (`public/brand/spotify/`, from its design page's download, byte for byte): black on light grounds, white on dark ones, at least 70 px wide, with clear space of half the icon's height |

The only voice route Spotify offers is its Commercial Hardware programme, for organisations.

## Spotify pauses while GIAP speaks

Policy III.7, as Jarida asked on 2026-09-30: "pause Spotify while GIAP speaks". Every sound the pond
makes asks for quiet first (`pond-core` `models/services/voice/quiet.rs`), and the Spotify side
(`pond-api` `spotify_focus.rs`) pauses what the Web API says is playing, on the device playing it: the
Spotify app, a speaker, a phone, or the pond's own Spotify page.

| Sound | Asks for quiet | Spotify comes back |
|---|---|---|
| A voice turn | At `begin_utterance`, before inference, so the pause is done before there is anything to say | 2 s after `end_utterance`, however long the gaps between sentences; a turn that fails still ends (`TurnEnds`) |
| The wake ping | Before it plays (it waits up to 400 ms for the pause); the quiet is renewed while the words after it are captured, and lasts 5 s after, for the turn to take over | When nothing holds it: a false wake gives Spotify back about 5 s after capture |
| The thinking tone | Starts only once Spotify is paused (up to 1.5 s); a tone stopped before then never starts | With the turn |
| Speech outside a turn (greeting, announcements, `/test/speak`) | Around each `speak` | 2 s after, unless another sound starts first |
| `/tts`, played by a browser (the web voice path, the voice preview) | Before the audio is returned | When it has played: its length from the WAV header, plus 3 s |

It resumes only what it paused, and only if nobody has changed it since: still paused, on the same
device, on the same track or episode. Pressing play, choosing another song or moving the music to
another device while GIAP talks is left as it is. A Spotify that disallows pausing right now
(`actions.disallows.pausing`) is left playing.

Two processes make sounds, and only one may write the secret store. The server pauses with its own
store and refreshes the token after a 401. The desktop's voice child reads the store fresh on each call
through `ReadOnlySecretStore` (`pond-infra`), which creates, migrates and writes nothing, and never
refreshes: a refresh can replace the refresh token, which it could not store. The server refreshes
every 45 minutes and a token lasts an hour, so the child's is current while the server runs; when it has
expired the child says so once in its log and GIAP speaks over Spotify. Every call goes through the
`network_mode` gate, and a sound waits at most 1.5 s for the pause.

**Policy III.3.** III.3 forbids a "voice-enabled SDA that enables a user to control Spotify with their
voice". The pause gives nobody that: nothing said to GIAP plays, skips or stops Spotify, the music comes
back by itself, and the pause happens because GIAP is about to make a sound, not because of anything
asked for. That is Jarida's reading of it, not Spotify's.

## Choosing the service and the player

The Music extension's settings lead with two choices, `MUSIC_SERVICE` and `MUSIC_PLAYER`. They are
`choice` requirements: fixed answers, validated when saved, and not secrets, so the settings read back
and show what was chosen (the first answer applies until one is saved). What each combination does:

| Service | Player | The assistant | The settings show | The music controls |
|---|---|---|---|---|
| Apple Music (default) | Player page (default) | Plays it on the page, the Music app as its fallback | Open the music player; the Apple key fields under Developer settings | Say where Apple Music plays, and open the page |
| Apple Music | The service's own app | Plays it in the Music app only | The Apple key fields | Say it plays in the Music app |
| Spotify | Player page | No music tools, and it says why | Spotify client ID, Sign in with Spotify, Open the Spotify player | Spotify's play or pause, drawn to its guidelines |
| Spotify | The service's own app | No music tools, and it says why | Spotify client ID, Sign in with Spotify | The same, for whichever device plays |

With Apple Music chosen, the pond does not ask Spotify for what is playing at all. An install from before
the choice existed that is signed in to Spotify keeps Spotify: the pond stores that once at startup
(`music_choice::keep_an_existing_choice`), so the new default does not switch it.

## What was measured

- **Why songs skipped (measured 2026-09-30, on the Electron player).** With Chrome's Widevine
  4.10.3112.0 pinned in castlabs' Electron, every `POST api.spotify.com/v1/widevine-license/v1/audio/license`
  answered HTTP 500 with an empty body: 21 in the console history, three per song live, and 18 of 18
  when the assistant played an album, which Spotify skipped through two seconds a song. A song's
  first moments are unencrypted, so it "played" briefly, then Chromium logged `DecryptingDemuxerStream:
  no key` and Spotify moved on. castlabs documents why: its prebuilt Electron is signed for Widevine
  **development** servers only, and production licences are denied without a production signature
  (castlabs/electron-releases#56); Spotify also refused signed apps, and in castlabs' own test played
  only once the User-Agent claimed Chrome (#80). An earlier note here blamed the module version and
  said signing would not help; both were wrong.
- MusicKit reports "playing" for a moment before a licence failure arrives, so the adapter confirms a
  play only once the position has advanced.
- **The browser page, against a scratch pond (2026-09-30).** In the browser pane: the page paired over
  loopback, got a developer token, asked the network check, loaded MusicKit v3 from Apple, configured
  it, attached to the bridge (`GET /player/state` read `attached: true`, `need: "authorization"`),
  showed Sign in, and a click on it made MusicKit open `authorize.music.apple.com` (the pane blocks
  popups from automated clicks, so the window itself did not appear). No console errors.

## The Electron build

Stock Electron (`^44.4.2`) again, 2026-09-30. castlabs' Electron was only there for the old in-app
player, and nothing needs DRM in the app now: the player pages run in the person's browser, which brings
its own. Its `postinstall`, `scripts/install-electron.mjs`, the two `electron-builder.yml` keys, and the
Widevine check and pin scripts are gone; the lockfile entry is the one from before the swap. After
pulling, `npm install` in `pond-desktop` with the app closed, then `npx install-electron` for the
binary (stock Electron 44 has no postinstall; CI does the same). A profile pinned earlier with the old
`widevine:pin` still holds a copy of Chrome's Widevine module in
`~/Library/Application Support/pond-desktop/WidevineCdm`; stock Electron ignores it, and it should be
deleted rather than kept.

## Known holes

- **The page must be open, and clicked once.** A browser will not let a page play sound it has not
  been clicked in; after the browser restarts, the first play asks for a press of Play on the page.
- **Loopback only.** The page pairs through the loopback pairing endpoint, so it runs on the pond's own
  computer. A Jetson has no documented environment for either SDK: Linux on arm64 has no browser with
  a Widevine module the services accept. There the assistant has no music tools, and says why.
- **Spotify pauses wherever it is playing.** III.7 names "any device or system", so the pause does not
  ask where the device is: someone listening on their phone away from home hears it pause whenever
  GIAP speaks at home, for the length of the exchange.
- **A voice session killed mid-speech leaves Spotify paused.** What was paused is resumed by the
  process that paused it, and a killed one resumes nothing.
- **Spotify is spoken over when it cannot be paused**: signed out, `network_mode` refusing it, a token
  the voice child may not refresh, a Web API call slower than 1.5 s, or Spotify disallowing the pause.
- **The browser's voice path makes two sounds of its own** (`playPingTone`, `playThinkingTone` in
  `webAudioUtils.ts`), which do not ask the pond for quiet; its speech, from `/tts`, does. It is a
  development surface; the desktop's voice runs in the voice child, where every sound asks.
- **Requests after the script loads are not judged** by `network_mode` (see Security model).

## Adding a service (Tidal...)

First read the service's own SDK documentation and follow it exactly. Then decide the style: does the
service's SDK, in JavaScript, do everything (a controller, as MusicKit), or does a REST API drive
playback that an existing provider already speaks (a speaker, as Spotify)?

1. `pond-desktop/src/player/adapters/<service>.ts`: implement `PlayerAdapter`. Only this file may
   know the SDK. Throw `PlayerError` with a stable code; a controller's `play` must resolve only when
   audio is really playing. A speaker implements `device()` and transport, and answers `unsupported`
   for what its REST provider does.
2. Register it in `adapters/index.ts`. If the SDK signs in with the person's token, add the service
   to `user_token_handler` in `player.rs`; if with a developer key, follow `musickit.rs`.
3. Host: add the service's API host to `service_host` in `player.rs` so `network_mode` can judge
   its network ops.
4. Extension: a controller constructs `new WebPlayerProvider({host, service, label, local,
   linkToId})` in `providers/index.ts` and widens `ServiceId` in `types.ts`.

## Verification

`npm test` in `pond-desktop` covers the Apple adapter against a fake MusicKit built from Apple's
reference (configure's instance, `startPlaying`, MKError codes, every playback state, pagination),
the page UI (artwork, the three controls, sign in and out), the music player row, the bridge and the
SSE reader. `cargo test -p pond-api --lib player` and `--test player_routes` drive the bridge.
`npm test` in `extensions/music` covers the providers over a fake host. The pause while GIAP speaks:
`cargo test -p pond-core --lib quiet`, `cargo test -p pond-api --lib spotify_focus` (the Web API by a
mock server, and the whole chain from a turn to the resume), `cargo test -p pond-infra --lib read_only`.

Not verified yet: signing in to Apple Music and full playback in Safari or Chrome (needs a person's
Apple Account), the Spotify page against Spotify in Chrome or Safari (needs a Premium sign-in and
a click on the page), and Spotify pausing and resuming against the real Web API while GIAP speaks
(needs the same sign-in).
