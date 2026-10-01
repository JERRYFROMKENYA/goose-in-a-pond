# Bringing the pond back after a power cut

Written 2026-09-28, against the device as it is configured today: host alias `pond`
(`192.168.1.14`), Linux user `exile`, repo at `/home/exile/goose-in-a-pond`, data at
`/home/exile/.local/share/goose-in-a-pond`.

**In the normal case you do nothing.** `goose-in-a-pond.service` is a *system* unit and it is
`enabled`, so the pond starts on boot without anyone logging in. This document is for the case
where it did not come back, or came back wrong — and for knowing, in under a minute, which of
those you are looking at.

Every command below is run from the Mac unless it is marked `[on the Jetson]`.

---

## 1. Is it already fine?

```bash
ssh pond 'systemctl is-active goose-in-a-pond.service; curl -s -o /dev/null -w "%{http_code}\n" --max-time 5 http://127.0.0.1:8080/api/v1/health'
```

`active` and `200` means the pond is up and you are done. Anything else, keep reading.

If the `ssh` itself fails, the board is not on the network yet — go to [§5](#5-it-is-not-on-the-network).

### What "up" looks like

```bash
ssh pond 'ss -lntp | grep pond-server'
```

Two listeners, and the split between them is the security boundary, not an accident:

| Listener | Reach | What it is |
|---|---|---|
| `127.0.0.1:8080` | loopback only | plain HTTP. Only reachable from the Jetson itself, or through an SSH tunnel. |
| `0.0.0.0:4443` | the whole LAN | HTTPS with the pinned certificate. This is what the phone talks to. |

If 8080 ever appears as `0.0.0.0:8080`, stop and fix that before anything else: it is the
unauthenticated-in-practice port, and it is meant to be unreachable from the network.

---

## 2. It is not running

```bash
ssh pond 'sudo systemctl start goose-in-a-pond.service'
```

Then give it time. The pond applies migrations, sizes the Jetson context, loads the GGUF embedder
and pre-warms the KV prefix **before** it binds a port, which is tens of seconds on this board. Poll
rather than guessing:

```bash
ssh pond 'for i in $(seq 1 30); do c=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:8080/api/v1/health); [ "$c" = 200 ] && { echo "up after ${i}0s"; break; }; sleep 10; done'
```

A `curl` that reports `000` is not a failure yet — it means nothing is listening, which is the
expected state while the model loads.

### If it starts and then dies

```bash
ssh pond 'systemctl status goose-in-a-pond.service --no-pager | head -20'
ssh pond 'journalctl -u goose-in-a-pond.service -b --no-pager | tail -60'
```

`Restart=on-failure` with `RestartSec=10` means a crash loop looks like a service that is "starting"
forever. `journalctl` is where it says why; `systemctl status` alone will not tell you.

---

## 3. It is running but the model will not load

This is the failure that actually follows a power cut, and it does not look like a memory problem.

After a boot the page cache fills with whatever was read on the way up. NvMap — the unified-memory
allocator the GPU uses — **cannot reclaim page cache**, so a small allocation (136 MiB, 143 MiB,
258 MiB are the ones seen here) fails while `free -h` cheerfully reports gigabytes available. The
error surfaces as an allocation failure, not as an out-of-memory.

```bash
ssh pond 'free -h'
```

If `buff/cache` is large and `available` looks generous but the model still will not load:

```bash
ssh pond 'sudo systemctl stop goose-in-a-pond.service && sudo sh -c "sync; echo 3 > /proc/sys/vm/drop_caches" && sudo systemctl start goose-in-a-pond.service'
```

Drop the caches **while the service is stopped**. Doing it under a running pond frees memory the
pond is about to want back, and the next turn simply refaults it.

For reference, a healthy loaded state on this board is roughly `4.4Gi` used with `2.8Gi` available.

---

## 4. It is running but answers slowly, or without tools

Decode here is memory-bandwidth-bound: `tok/s ≈ 102 / model_GB`. A 2 GB model gives about
22 tok/s. If it is much worse than that, the likely causes in order:

1. **A debug binary is being served.** `ExecStart` points at `target/release/pond-server`. If a
   `target/debug` build got there instead, everything runs on the CPU cores with no GPU.
   ```bash
   ssh pond 'ls -la ~/goose-in-a-pond/target/release/pond-server'
   ```
2. **The build lost CUDA.** A build without the `cuda` feature looks completely normal and is many
   times slower.
   ```bash
   ssh pond 'journalctl -u goose-in-a-pond.service -b --no-pager | grep -i "cuda\|gpu\|Jetson context" | head'
   ```
3. **Something else is holding the GPU or the cores.**
   ```bash
   ssh pond 'ps aux --sort=-%cpu | head -6'
   ```

Note that the log line `Jetson context sized to fit this model's KV cache in the LLM budget` reports
`drafter_mb=57`, and that is a phantom: speculative decoding was removed from the llama.cpp engine
upstream on 2026-09-24. The budget still charges for a drafter that is never loaded. It is not a
symptom of anything.

---

## 5. It is not on the network

Console access needs a monitor and keyboard on the board itself. Before that, check whether it is
simply a name-resolution problem rather than a down device:

```bash
ping -c 2 192.168.1.14
```

If the IP answers but `ssh pond` does not, the alias or mDNS is the problem, not the pond.

`[on the Jetson]` The WiFi interface is `wlP1p1s0` on connection `GojoSatoru`:

```bash
nmcli -t -f DEVICE,STATE,CONNECTION device
nmcli connection up GojoSatoru
```

### DNS

The home router at `192.168.1.1` drops AAAA queries, which does not present as a DNS fault. It
presents as everything being slow: 15-second name lookups, the weather tool timing out at 10
seconds, `npm` failing with `ENOTFOUND`. The Jetson is configured to bypass it:

```bash
ssh pond 'resolvectl dns wlP1p1s0'
```

Expected: `Link 3 (wlP1p1s0): 1.1.1.1 8.8.8.8`. Ask the link by name — `resolvectl status` on its
own prints a global "Fallback DNS Servers" line and a `can0` link above the WiFi one, so it is easy
to read the wrong answer off it. If the WiFi link has reverted to the router:

```bash
ssh pond 'sudo nmcli connection modify GojoSatoru ipv4.ignore-auto-dns yes ipv4.dns "1.1.1.1 8.8.8.8" && sudo nmcli connection up GojoSatoru'
```

The same router affects the Mac and the phone independently — each device needs its own fix. On the
phone that is Private DNS set to `one.one.one.one`.

---

## 6. Reaching it from the Mac

The dashboard is on the loopback-only port, so it needs a tunnel:

```bash
ssh -N -L 8080:127.0.0.1:8080 pond
```

Leave that running and open `http://127.0.0.1:8080`.

Using the tunnel rather than the LAN port matters for more than convenience: the browser's origin is
then loopback, which is what the auth path expects. Going to `https://192.168.1.14:4443` in a
browser instead will present the pinned certificate, which the browser has no reason to trust.

The phone does not need any of this — it talks to `4443` directly and pins the certificate itself.

**Do not set `POND_DEV_ALLOW_LOOPBACK` to work around an auth problem.** With it on, anything that
reaches loopback drives the whole API with no token, on a device holding household memory, device
control and an encrypted secret store. If it was ever set for a debugging session, unset it and
restart.

---

## 7. The sidecars

Two other processes belong to a healthy pond, and neither is managed by the unit:

```bash
ssh pond 'ss -lntp | grep -E "node|pondnet"'
```

- **`node` on `127.0.0.1:5580`** — the matter.js controller sidecar. Without it, Matter devices
  stop responding while everything else works normally.
- **`pondnet`** on a high port — peer discovery.

Both are started by the server. If one is missing, restarting the service is the remedy; they are
not started by hand.

---

## 8. After an unclean shutdown, check the databases

A power cut during a write leaves WAL files behind. SQLite recovers from them on open, so their
presence is normal — what matters is that the pond opened them without complaint:

```bash
ssh pond 'ls -la ~/.local/share/goose-in-a-pond/*.db*'
ssh pond 'journalctl -u goose-in-a-pond.service -b --no-pager | grep -iE "migrat|corrupt|sqlite" | head'
```

`pond_system.db` is authoritative — devices, schedules, memory, settings, sessions. `pond_logs.db`
is disposable. If the system database were ever genuinely damaged, that is a restore, not a repair,
and it is the one thing on this board worth having a backup of.

---

## Known-stale tooling

`scripts/jetson/deploy.sh` does not match this device. It assumes ssh host `nano`, user `nano`, and
a **user** systemd unit (`systemctl --user restart`). This board runs a **system** unit as user
`exile`, reached as `pond`, and has no user unit at all — so the deploy script's restart step cannot
work here. Use the commands in this document, and treat the script as unverified until someone
reconciles it.

---

## The short version

```bash
# Is it up?
ssh pond 'systemctl is-active goose-in-a-pond.service; curl -s -o /dev/null -w "%{http_code}\n" --max-time 5 http://127.0.0.1:8080/api/v1/health'

# Start it
ssh pond 'sudo systemctl start goose-in-a-pond.service'

# Start it after a power cut, when the model will not load
ssh pond 'sudo systemctl stop goose-in-a-pond.service && sudo sh -c "sync; echo 3 > /proc/sys/vm/drop_caches" && sudo systemctl start goose-in-a-pond.service'

# Why did it fail
ssh pond 'journalctl -u goose-in-a-pond.service -b --no-pager | tail -60'

# Reach the dashboard
ssh -N -L 8080:127.0.0.1:8080 pond    # then http://127.0.0.1:8080
```
