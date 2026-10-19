# The pond's connections and pairing settings

How a household sees and changes the pond's network links (Wi-Fi, Ethernet, Bluetooth) and its
pairing settings, from goose-on-the-go and from both desktop settings views. The setup channel
(`pond-setup-channel.md`) covers a pond with no network; this covers a pond that is already reachable.

Status: **contract v1, 2026-10-19**. Server side in `pond-core::network` (ports) and `pond-connect`
(adapters); the phone and desktop build against the shapes below.

## Decisions

| Date | Decision | Why |
|---|---|---|
| 2026-10-19 | **One read, `GET /api/v1/connections`, describes every link at once.** | A settings screen draws all three sections from one request, and the phone polls one route while a join settles. |
| 2026-10-19 | **Reads take any paired token; changes take the host credential, the device that claimed the pond, or a device attributed to a household member.** | Moving the pond to another network can cut every phone off it. An unattributed device (a guest's phone) can see the links but not change them. The claimant counts before onboarding finishes, so owner setup can fix the network. |
| 2026-10-19 | **The setup channel's Wi-Fi codes and shapes are reused unchanged.** | The phone already speaks them over Bluetooth (`wifi_scan`, `wifi_join`); the same reader handles both transports. |
| 2026-10-19 | **Forgetting the network the pond is using now needs `"confirm": true`.** | Without another usable link it takes the pond off the LAN, and the household then needs the setup channel to bring it back. |
| 2026-10-19 | **Ethernet is read-only.** | There is nothing to choose on a cable; the household needs to see the link and the address. |
| 2026-10-19 | **Bluetooth's switch is the existing `ble_setup_enabled` setting.** | One switch, already in both desktop views; this adds what the radio is doing to the same screen. |
| 2026-10-19 | **A phone asking for a pairing code for another device is not in v1.** | It needs a decision on what proves the asker is that member (see "Open"). Codes stay host-issued: the desktop, the dashboard, or `pond-server pairing`. |

## Routes

All under `/api/v1`. Every refusal is `{"error": "<code>"}` with the status below; codes match the
setup channel's where the meaning is the same.

### `GET /connections`

Any paired token, in every state. Never tokenless.

```json
{
  "hostname": "nano",
  "https_port": 4443,
  "wifi": {
    "state": "connected",
    "ssid": "Home",
    "address": "192.168.1.11",
    "signal": 70,
    "capabilities": {
      "scan":   {"available": true,  "reason": null},
      "join":   {"available": false, "reason": "the pond's user may not change Wi-Fi (run: bash scripts/giap.sh wifi-grant)"},
      "forget": {"available": false, "reason": "..."}
    }
  },
  "ethernet": [
    {"interface": "eth0", "link": "up", "address": "192.168.1.20", "speed_mbps": 1000}
  ],
  "bluetooth": {
    "enabled": true,
    "state": "advertising",
    "reason": null,
    "advertising_as": "Pond 4e81",
    "session_open": false
  },
  "can_change": true
}
```

- `wifi.state`: `connected` | `disconnected` | `unavailable` (no Wi-Fi hardware or no station on this
  OS; `reason` says which). `ssid`, `address`, `signal` are `null` when not connected.
- `ethernet`: one entry per wired interface, `[]` when there is none. `link`: `up` | `down`.
  `address` is the first IPv4, or `null`. `speed_mbps` is `null` when the OS does not say.
- `bluetooth.state`: `off` | `serving` | `advertising` | `unavailable`, with `reason` for the last.
  `advertising_as` is the label phones see (`Pond <id>`), `null` when not advertising.
- `can_change`: whether this caller may use the write routes below, so a screen can disable them
  instead of failing.

### `GET /connections/wifi/networks`

Any paired token. Scans now and answers the ranked list: strongest first, one entry per SSID, at most
50, hidden networks left out.

```json
{"networks": [{"ssid": "Home", "security": "wpa2", "signal": 70, "known": true, "current": true}]}
```

- `security`: `open` | `wep` | `wpa` | `wpa2` | `wpa3` | `enterprise` (the setup channel's set).
- `known`: the pond has this network saved. `current`: the pond is on it now.
- Refusals: `503 unsupported` (no station), `403 not_permitted` (the OS refuses the scan; macOS
  without Location permission), `409 busy` (a join is in progress).

### `POST /connections/wifi/join`

Changers only (see Decisions). Body: `{"ssid": "Home", "passphrase": "…", "hidden": false}`;
`passphrase` is omitted for an open network. Waits for the result, up to 45 s.

- `200 {"ssid": "Home", "address": "192.168.1.11", "https_port": 4443, "hostname": "nano"}`
- `400 invalid_request` (empty or over-long SSID, a passphrase of the wrong length),
  `401 wrong_password`, `404 not_found`, `504 timeout`, `502 no_address`,
  `403 not_permitted` (the polkit grant is missing on Linux), `403 not_allowed` (this caller may not
  change the pond's network), `503 unsupported`, `409 busy`.
- A join that moves the pond to another LAN ends this HTTPS connection's reach. The phone then finds
  the pond again by its `_pond._tcp` record or, failing that, over Bluetooth.
- The passphrase is never logged, stored in settings, or echoed. The OS keeps it with the saved
  network once the join succeeds, and not before.

### `DELETE /connections/wifi/networks/{ssid}`

Changers only. Forgets a saved network. `{ssid}` is percent-encoded.

- `204`.
- `404 not_found` (nothing saved by that name), `409 in_use` (the pond is on it now; repeat with
  `?confirm=true` to forget it anyway), `403 not_permitted` / `not_allowed`, `503 unsupported`.

### Pairing settings

No new routes in v1. The phone reads and writes these through `GET /settings` and `PUT /settings`
(a changer's token, as for every setting):

| Setting | Default | Meaning |
|---|---|---|
| `ble_setup_enabled` | on | The pond may be found and set up over Bluetooth (advertising while unclaimed or offline). |
| `spoken_pairing_codes` | on | A phone may ask the pond to read a pairing code aloud. |

`GET /connections` (`bluetooth`) and `GET /setup/status` (below) show their effect.

### `GET /setup/status`

Any paired token. The setup card's state, never its code.

```json
{"id": "4e81", "claimed": true, "claimed_at": "2026-10-18T18:06:12Z", "claimed_by_this_device": false}
```

Re-arming the card stays on the host (`pond-server setup-code --rearm`).

## Errors at a glance

| Code | Status | Where |
|---|---|---|
| `not_allowed` | 403 | any write, by a caller who may not change the pond's network |
| `not_permitted` | 403 | the OS refused (no polkit grant, no Location permission) |
| `unsupported` | 503 | no Wi-Fi station on this host |
| `busy` | 409 | a scan or join is already running |
| `in_use` | 409 | forgetting the current network without `confirm` |
| `wrong_password`, `not_found`, `timeout`, `no_address` | 401, 404, 504, 502 | join |
| `invalid_request` | 400 | malformed body or SSID |

## Open

- **A phone issuing a pairing code for a new device of its own member.** It needs Jerry's decision on
  what proves the asker is that member: an already-attributed device of theirs, the host, or more.
  Until then, codes are host-issued.
- **Ethernet configuration** (static address, DHCP) is out of v1.
