# Security

## Threat model

BabyLink is a self-hosted baby monitor. The following summarises what
the server knows and what is protected.

### Room access

- **Room IDs** are 128-bit random tokens generated at room creation
  (`POST /api/rooms`). They function as unguessable bearer secrets:
  possession of the room ID is sufficient to join as a listener.
  Do not share room URLs with untrusted parties.

- **Owner token** — also minted at room creation and returned once.
  Store it; it cannot be recovered. The owner token is required for
  room management operations (rename, delete, change PIN, configure
  ntfy). Without it the room is read-only to anyone holding the ID.

- **Room PIN** — an optional second factor that gates the listen/baby
  role. PINs are hashed with a salted KDF before storage; the server
  never retains the plaintext. The room owner may join with the owner
  token instead of the PIN.

### What the server can see

The server is a thin signaling broker. For WebRTC sessions between two
browsers, **audio never passes through the server** — only the SDP/ICE
offer/answer exchange does.

Regardless of deployment mode the server has access to:

- **Signaling metadata**: which room IDs are active, when peers
  join/leave, peer role (baby/parent).
- **Device names and room labels** as set by the user.
- **Client IP addresses** (in process logs; not stored persistently by
  default).
- **ntfy topic identifiers** if push notifications are configured.

ESP32-S3 (XIAO) devices send audio on two paths at once: a WebRTC
(Opus, peer-to-peer) stream, and a **raw 16-bit PCM stream over the
device's WebSocket to the server**, which the server relays unmodified
to the parents in the room (`esp32-audio`). The server does not analyse
or store it, but the PCM relay is plain audio inside the TLS connection:
whoever operates the server can listen to it. Self-host if that matters
to you; a public/demo instance operator could hear ESP32-S3 babies.

### Device registration

A device registers with its room ID and MAC address. Newer firmware also
sends a per-device token that it generates once and keeps across factory
resets; the server trusts the first token it sees for a device in a room
and requires it from then on, so knowing a MAC is not enough to take over
or kick a registered device. Devices running older firmware send no token
and are accepted as before. Anyone who knows a room ID can still register
an extra (fake) device into that room — the same as joining it as a baby
from a browser — so keep room links private and use a PIN. The owner can
release a device's token (e.g. after a full flash erase gave it a new one)
via `DELETE /api/rooms/:roomId/esp32/:esp32Id/token`.

### Device setup (BLE and the setup access point)

The device's BLE config and its setup portal never return stored WiFi
passwords, and hide the room ID until the setup window is opened with a
tap on the BOOT button; changing the configuration needs that tap too.
WiFi credentials are still sent **unencrypted** over BLE and over the
open setup access point while you set the device up — do it somewhere an
eavesdropper is unlikely to be in radio range.

### Deployment advice

- Run behind HTTPS (Caddy or similar). `getUserMedia` requires a
  secure context; plain HTTP works only on `localhost`.
- Use the owner token to set a PIN on any room that is accessible to
  others on the network.
- On public instances, keep `ROOM_CREATE_LIMIT` low and consider
  rotating room IDs regularly. Unused rooms without a PIN or
  notifications are forgotten after `ROOM_CONFIG_TTL_DAYS`.

---

## Reporting a vulnerability

Please report security issues **privately** via GitHub's private vulnerability
reporting — the *Report a vulnerability* button under the repository's
**Security** tab
(<https://github.com/mkampl/babylink/security/advisories/new>).

Include enough detail to reproduce the issue.

Please do not open public GitHub issues for security vulnerabilities.
