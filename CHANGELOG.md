# Changelog

## [1.0.1] — 2026-07-19

First stable release after beta testing on Dahua **VTO2111D** + Homebridge **2.1.x**.

### Features
- Video doorbell: live H.264 stream via ffmpeg
- Doorbell ring + motion from Dahua event stream
- Door unlock via `accessControl.cgi` (Scrypted Amcrest-compatible)
- Two-way audio via `audio.cgi` G.711A (Amcrest / Scrypted Dahua path: `pipe:3`, 1024-byte chunks, realtime ≤ 8 kB/s)
- Optional HomeKit Secure Video (off by default)
- Homebridge UI config schema
- Node.js 18 / 20 / 22 / 24

### Fixes (from beta)
- Digest auth for `audio.cgi` via GET challenge (empty POST hung on VTO)
- Talkback quality/latency aligned with Scrypted Amcrest
- Stable accessory UUID (`name` / `accessoryId`) — changing VTO IP no longer recreates the accessory
- Removed auto-`unregister` of stale accessories at startup (caused child-bridge SIGTERM loops)
- Safer `configureController` on restore
- Clear warning: **Child Bridge is not supported** for this plugin on HB 2.x

### Known limitations
- Run in the **main** Homebridge process (disable Child Bridge)
- Talkback needs ffmpeg built with `libfdk_aac` (ffmpeg-for-homebridge)
- HKSV is optional and should be enabled only after live view works

---

## [1.0.1-beta.3] — 2026-07-19
- Document / log Child Bridge unsupported
- Schema header warning

## [1.0.1-beta.2] — 2026-07-19
- Stable UUID; no startup unregister; HKSV default off

## [1.0.1-beta.1] — 2026-07-19
- Node 24 engines; child-bridge restore hardening

## [1.0.0] — 2026-07-19
- Initial npm publish (pre-stable)
