# The pond administrator ("agamemnon") and My Pond

Status: decided by Jerry on 2026-10-29. My Pond is the phone's administration area: storage and
stats, a file browser with delete, cache clearing, long-task artifacts and reports, system health,
and power modes. Every one of those is destructive or privacy-sensitive, so being paired is not
enough to reach them. This note says who may, how they prove it, and how the proof is recovered.

## Decisions

| Question | Decision |
|---|---|
| How a phone proves it is the administrator | The **admin card**: a password made at install and printed on its own card. The pond keeps only a slow verifier of it. The plaintext is sealed to the board's TPM, so only root on that board can print it again |
| The `agamemnon` OS account | A **locked service account**: no password, no shell. It owns the service when the service is moved to it, and a sudoers drop-in lets it run exactly `nvpmodel -m <id>` and a reboot |
| Moving the service to `agamemnon` | **Offered at install** on new ponds. The nano moves later, once the audio path works under a system account |
| Where a phone may unlock from | **The household LAN and remote access**. Over the tailnet the token must already come from its device's enrolled machine (the auth middleware's rule) |

Rejected: a code the pond speaks each time (anyone in earshot holds it, and a pond with a broken
speaker could not be administered); shorting the J14 Force Recovery pins (awkward, devkit-only); a
secret derived from board IDs (`/proc/device-tree/serial-number` is world-readable, so it is not a
secret).

## What the pond already had

| Proof | Who holds it | Reaches |
|---|---|---|
| Bearer token | any paired device, member or guest | every protected route |
| Host credential (`.runtime_host_credential`, rotated each start) | processes of the service's OS account | host-only routes over loopback |
| Setup card (eleven digits) | whoever has the printed card | the first pairing, only while unclaimed |
| Spoken pairing code | anyone in earshot | one pairing |

None of these says "this person may administer the pond".

## What the nano offers (read 2026-10-29)

- A firmware TPM (`/dev/tpm0`, `/dev/tpmrm0`, OP-TEE fTPM) with `tpm2-tools` installed. A secret
  sealed to it cannot be unsealed from a copy of the disk on another board.
- `nvpmodel` modes from `/etc/nvpmodel.conf`: 0 = 15W, 1 = 25W (the default), 2 = MAXN_SUPER,
  3 = 7W. Setting one needs root. Supply power comes from the INA3221 (`VDD_IN`). There is no
  battery.
- The service is a user unit of `nano`; audio goes through that user's PulseAudio session, which a
  system account does not have. That is why the nano's move waits.

## The admin card

- **Format.** Sixteen Crockford base32 characters, printed `XXXX-XXXX-XXXX-XXXX` (80 bits).
  Input ignores case, dashes and spaces, and reads `O` as `0` and `I` or `L` as `1`.
- **Made** by `bash scripts/giap.sh admin-card` (run by `scripts/install.sh`). It asks
  `pond-server admin-card` for a new card as the pond's own user, seals the plaintext, prints the
  card once, and installs the power drop-in. `admin-card show` prints the sealed card again, and
  `admin-card rotate` replaces it.
- **Stored** on the pond as `<data>/setup/admin.json`, `{version, card_id, verifier, created_at}`,
  mode `0600` in the `0700` setup directory. It is never in `Settings` or the database, and
  `pond-snapshot.py` leaves the setup directory out. The verifier is PBKDF2-HMAC-SHA256 at 600,000
  rounds (`pbkdf2` was already in the lock; Argon2 would have been a new dependency). The
  password's 80 random bits are what defeat an offline guess at a leaked file; the rounds are
  defence in depth, and the throttle below is what stops online guessing.
- **Read live.** The server reads the file on every unlock and every admin request, so
  `giap.sh admin-card rotate` takes effect at once and locks every device unlocked with the old
  card. `pond-server admin-card` refuses to replace a card unless told to rotate.
- **Recovery copy.** On a board with a TPM it is sealed under the owner hierarchy, in
  `/var/lib/goose-in-a-pond-admin/` (root, `0700`). The primary key is re-derived from the owner
  seed each time, so the sealed blob opens on this board only; clearing the TPM loses it, and the
  card is then rotated. Without a TPM it is a root-only file there.
  On macOS it goes in the login Keychain. On hosts without a TPM, "root on the device" is the whole
  boundary.
- **Guessing.** Wrong passwords are slowed the way the setup code is: five free, then one per
  30 s, doubling up to one per 10 min, across every client, held in memory.

## Unlocking

1. My Pond shows only on a member's phone, never a guest's (`admin_members_only`).
2. The phone sends the card to `POST /api/v1/admin/unlock`.
3. Success unlocks that device only, for 15 minutes from its last admin request. A restart, a
   new card, or `POST /admin/lock` ends it sooner.
4. Every other `/api/v1/admin/*` route answers `403 admin_locked` until then.
5. Each unlock, refusal and destructive action is an audit event. Other members' phones are told
   when administration is unlocked.
6. The phone confirms every delete, cache clear, power-mode change and restart, with the safe
   choice as the default.

## Wire contract

Every route is under `/api/v1/admin`, needs a token, and is behind the onboarding guard. A caller
that is not a member's device gets `403 {"error":"admin_members_only"}`. Sizes are bytes and times
are RFC 3339.

| Route | Answer |
|---|---|
| `GET /status` | `{card: "present"\|"missing", unlocked, expires_at, idle_minutes, retry_after}` |
| `POST /unlock {password}` | `200 {unlocked: true, expires_at}`; `403 admin_password_rejected`; `400 admin_password_malformed`; `409 admin_card_missing`; `429 admin_cooling` with `retry_after` and `Retry-After` |
| `POST /lock` | `204` |
| `GET /overview` | `{disk: {total_bytes, free_bytes}, data_dir_bytes, areas: [{id, bytes}], databases: [{name, bytes}], counts: {sessions, messages, memories, long_tasks, artifacts, models}}` |
| `GET /files?path=` | `{path, entries: [{name, path, kind: "file"\|"directory"\|"symlink", bytes, modified_at, deletable, reason}]}`, largest first |
| `DELETE /files?path=` | `200 {freed_bytes}`; `400 invalid_path`; `403 protected_path` with `reason`; `404 not_found` |
| `GET /caches` | `{caches: [{id, bytes, files}]}` |
| `POST /caches/{id}/clear` | `200 {freed_bytes}`; `404 unknown_cache` |
| `GET /tasks` | `{tasks: [{id, goal, another_member, state, kind, created_at, finished_at, has_report, artifacts: [{id, title, kind, tokens, created_at}]}]}` |
| `DELETE /tasks/{id}` | `200 {deleted: true}`; `404 not_found`; `409 task_active` |
| `DELETE /tasks/{id}/artifacts/{artifact_id}` | as above |
| `GET /health` | `{version, uptime_secs, host: {hostname, os, arch, cpus, uptime_secs, load}, memory: {total_bytes, available_bytes, swap_total_bytes, swap_free_bytes}, disk, temperatures: [{zone, celsius}], process: {rss_bytes}, checks: [{id, status: "ok"\|"warning"\|"critical"}]}` |
| `GET /power` | `{control: "nvpmodel"\|"none", mode: {id, name}\|null, default_mode_id, modes: [{id, name}], can_change, supply: {millivolts, milliamps, milliwatts}\|null, battery: {percent, charging}\|null}` |
| `PUT /power/mode {id}` | `200 {mode, reboot_required}`; `400 unknown_power_mode`; `503 power_control_unavailable` |
| `POST /power/restart {force?}` | `202 {restarting: true}`; `409 long_task_running` unless `force`; `503 power_control_unavailable` |

- **Areas** (`overview.areas[].id`): `models` (`models/` and `hf_cache/`), `conversations` (the
  databases), `kv_snapshots`, `engine_caches`, `attachments`, `camera`, `logs`, `other`.
- **Files.** Paths are relative to the data directory and must stay inside it. `..`, absolute
  paths and symlinks out are refused. `setup/`, `tls/`, `secrets/`, `secrets.json`,
  `embedded-network/` and the `.runtime_*` files are never listed. The live databases are listed
  but not deletable (`reason: "in_use"`), and nor are `models/` and `hf_cache/`
  (`reason: "managed_by_models"`: remove a model through Models instead).
- **Caches**: `kv_snapshots` (the engines' saved prompt states; the long-task `suspended/` states
  are kept), `download_leftovers` (`hf_cache` blobs no model uses, stale partial downloads), and
  `accelerator_caches` (TensorRT and LiteRT build caches, rebuilt on the next load, which is then
  slower). Build output such as `target/` is never in scope.
- **Tasks.** Another member's task shows its state, kind, dates and artifact count, but its
  `goal` and artifact `title`s are `null` and `another_member` is true. The admin may still delete
  it. Only a finished task, or an artifact of one, can be deleted.
- **Health checks**: `disk_space` (warning under 10 % free, critical under 5 %), `memory`
  (warning under 10 % available), `temperature` (warning at 80 °C, critical at 90 °C).
- **Power.** `can_change` is whether the service may run `nvpmodel` through `sudo -n`, which
  `giap.sh admin-card` allows with `/etc/sudoers.d/goose-in-a-pond-power`: only
  `nvpmodel -m [0-9]` and `systemctl reboot`, installed only after `visudo -c` passes it. A mode
  change reports `reboot_required` when `nvpmodel` asks for one; the phone then offers a restart.

## Not in this change

- **The `agamemnon` account and moving the service to it.** A pond run by a system account has no
  voice until audio stops depending on a login's PulseAudio session, and the install path needs a
  fresh install to prove it. Until then the card's administrator is named `agamemnon` in the audit
  trail and the card text, and the power drop-in names whichever account runs the service.
- **The desktop app.** My Pond is on the phone only; the desktop already reaches the host through
  the host credential.
