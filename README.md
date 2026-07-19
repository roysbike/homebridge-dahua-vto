# homebridge-dahua-vto

Homebridge plugin for **Dahua VTO** door stations (tested with **VTO2111D**):

- Live camera (H.264 via ffmpeg)
- Doorbell button events
- Motion
- Door lock / unlock (`accessControl.cgi`)
- **Two-way audio** — Scrypted Amcrest path (`audio.cgi` G.711A, 1024-byte chunks @ 8 kHz)
- Optional **HomeKit Secure Video** (HKSV)

## Requirements

- [Homebridge](https://homebridge.io/) `^1.8` / `^2`
- Node.js `18` / `20` / `22` / `24`
- **ffmpeg with `libfdk_aac`** for talkback (AAC-ELD). Recommended: [ffmpeg-for-homebridge](https://github.com/homebridge/ffmpeg-for-homebridge)
- LAN access to the VTO (HTTP CGI + RTSP)
- **Child Bridge: OFF** — camera/doorbell controllers are unstable in Homebridge 2.x child bridges. Run this platform in the **main** bridge.

## Install

```bash
npm install -g homebridge-dahua-vto
# or in Homebridge UI: Plugins → search "dahua-vto" → Install
```

Restart Homebridge, then add the platform in the UI or `config.json`.

## Config example

```json
{
  "platforms": [
    {
      "platform": "DahuaVTO",
      "name": "Dahua VTO",
      "cameras": [
        {
          "name": "Front Door",
          "host": "192.168.80.8",
          "username": "admin",
          "password": "YOUR_PASSWORD",
          "doorChannel": 1,
          "unlockSeconds": 5,
          "twoWayAudio": true,
          "hksv": false,
          "ffmpegPath": "/usr/local/bin/ffmpeg"
        }
      ]
    }
  ]
}
```

Do **not** add a `_bridge` / Child Bridge block for this platform.

### Optional fields

| Field | Default | Notes |
|---|---|---|
| `rtspUrl` | auto | Full RTSP URL override |
| `rtspSubtype` | `0` | Main/sub stream if `rtspUrl` not set |
| `ssl` | `false` | HTTPS for CGI |
| `ffmpegPath` | `ffmpeg` | Path to ffmpeg-for-homebridge |
| `twoWayAudio` | `true` | Mic in Home → VTO speaker |
| `hksv` | `false` | Enable after live view/talkback work |
| `accessoryId` | `name` | Stable HomeKit UUID seed — do not change after pairing |
| `motionTimeoutMs` | `10000` | Auto-clear motion |

## Two-way audio

Same CGI as Scrypted (**Doorbell Type = Dahua**):

```text
POST /cgi-bin/audio.cgi?action=postAudio&httptype=singlepart&channel=1
Content-Type: Audio/G.711A
```

Home app → open camera → hold the microphone.

## Unlock

```text
GET /cgi-bin/accessControl.cgi?action=openDoor&channel=1&UserID=101&Type=Remote
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Child bridge `SIGTERM` loop | Disable Child Bridge; run in main bridge |
| `ECONNREFUSED` on event stream | `host` must be the **VTO IP**, not the Homebridge host |
| No talkback / garbled audio | Use ffmpeg-for-homebridge (`libfdk_aac`); keep `twoWayAudio: true` |
| Duplicate accessories after rename | Set fixed `accessoryId`; remove stale accessories in UI |

## Versioning

| Channel | Install |
|---|---|
| Stable | `homebridge-dahua-vto` / `@latest` |
| Beta | `homebridge-dahua-vto@beta` |

```bash
OTP=XXXXXX ./publish.sh stable   # latest
OTP=XXXXXX ./publish.sh beta     # pre-release
```

## License

MIT
