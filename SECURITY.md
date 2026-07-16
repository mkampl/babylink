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
  never retains the plaintext.

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

For ESP32-S3 (XIAO) devices connected via the WebSocket proxy, the
device streams **Opus-encoded audio** to the server for WebRTC
re-signaling; the server decodes nothing but does relay packets. A
self-hosted instance means you control this path. A public/demo
instance operator can observe the encrypted Opus stream.

### Known residual: device authentication

ESP32-S3 device registration is not yet device-authenticated. Any
client that knows the server's WebSocket endpoint and a valid room ID
can register as a device. A per-device provisioning token (minted
during BLE setup and verified on registration) is planned. Until that
lands, trust in device identity depends on room-ID secrecy and network
access controls.

### Deployment advice

- Run behind HTTPS (Caddy or similar). `getUserMedia` requires a
  secure context; plain HTTP works only on `localhost`.
- Use the owner token to set a PIN on any room that is accessible to
  others on the network.
- On public instances, consider rate-limiting room creation and
  rotating room IDs regularly.

---

## Reporting a vulnerability

Please report security issues **privately** via GitHub's private vulnerability
reporting — the *Report a vulnerability* button under the repository's
**Security** tab
(<https://github.com/mkampl/babylink/security/advisories/new>).

Include enough detail to reproduce the issue.

Please do not open public GitHub issues for security vulnerabilities.
