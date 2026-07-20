# Changelog

## [1.0.9] — 2026-07-20

- HomeKit identity from VTO API: **getVendor**, **getSystemInfo** (model, serial), **getSoftwareVersion** (real firmware string)
- Serial number no longer defaults to VTO IP; refresh runs immediately at start
- Config manufacturer/model/firmware/serial are optional overrides only (leave empty for auto)

---

## [1.0.8] — 2026-07-20

- Option `enableMotionDetect` (default **true**): at start, if VTO MotionDetect is off, enable it via `configManager.cgi?action=setConfig&MotionDetect[0].Enable=true`

---

## [1.0.7] — 2026-07-20

- Fix walk-by motion / HKSV: map SmartMotionHuman, CrossLine/Region, FaceDetection, etc. (not only VideoMotion)
- Accept VideoMotion `Pulse` as motion start
- On startup, check VTO `MotionDetect.Enable` and warn if disabled (common reason HKSV never records walk-bys)
- More reliable MotionDetected updates for HomeKit Secure Video

---

## [1.0.6] — 2026-07-20

- Card access: Contact sensor «Card Access» (`DoorCard` / `AccessControl` with CardNo)
- Exit button: Contact sensor «Exit Button» (`AlarmLocal` index 3 + AccessControl Method=5)
- Sync Lock to unlocked when door opens via card/exit
- Doorbell dedupe for `CallNoAnswered` + `Invite`
- Quiet debug noise (`SIPRegisterResult`, `TimeChange`, `NTPAdjustTime`, …)

---

## [1.0.5] — 2026-07-20

- Auto-fill HomeKit Accessory Information from VTO `magicBox.cgi` (`getSystemInfo` / `getSoftwareVersion`): model, serial, hardware, firmware

---

## [1.0.4] — 2026-07-20

- Move `homebridge` to `devDependencies` only (Verified check)

---

## [1.0.3] — 2026-07-20

- Removed Child Bridge warnings from docs, schema, and runtime logs (works fine in practice)
- Display name: **Homebridge Dahua VTO**

---

## [1.0.2] — 2026-07-20

Aligned with [Verified By Homebridge](https://github.com/homebridge/verified) expectations and cleaned the published package.

### Added
- Platform and per-camera **`debug`** option (verbose CGI events, streams, talkback; unknown events logged for issue reports)
- Documented support: **DHI-VTO2211G-WP** (tested), **VTO1201G** and similar CGI-compatible models
- Safer event parsing (errors caught and logged)

### Changed
- Node engines: `^20 || ^22 || ^24` (covers current Homebridge LTS targets 22 & 24)
- README / schema updated for models, debug, and GitHub issues
- Removed local publish/deploy shell scripts from the repo

### Notes
- Still no analytics or post-install system changes
- Plugin remains idle until a door station is configured

---

## [1.0.1] — 2026-07-19

First stable release after beta testing.

### Features
- Video doorbell: live H.264 stream via ffmpeg
- Doorbell ring + motion from Dahua event stream
- Door unlock via `accessControl.cgi` (Scrypted Amcrest-compatible)
- Two-way audio via `audio.cgi` G.711A
- Optional HomeKit Secure Video (off by default)
- Homebridge UI config schema

### Fixes (from beta)
- Digest auth for `audio.cgi` via GET challenge
- Stable accessory UUID (`name` / `accessoryId`)
- No auto-`unregister` of stale accessories at startup
- Child Bridge unsupported warning

---

## [1.0.1-beta.3] — 2026-07-19
- Document / log Child Bridge unsupported

## [1.0.1-beta.2] — 2026-07-19
- Stable UUID; no startup unregister; HKSV default off

## [1.0.1-beta.1] — 2026-07-19
- Node 24 engines; child-bridge restore hardening

## [1.0.0] — 2026-07-19
- Initial npm publish (pre-stable)
