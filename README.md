# homebridge-dahua-vto

Homebridge plugin for **Dahua VTO** door stations (tested with VTO2111D):

- Live camera (H.264 via ffmpeg)
- Doorbell button events
- Motion
- Door lock / unlock (`accessControl.cgi`)
- **Two-way audio** — same path as Scrypted Amcrest (`audio.cgi` G.711A, 1024-byte chunks @ 8 kHz)
- Optional **HomeKit Secure Video** (HKSV)

## Requirements

- [Homebridge](https://homebridge.io/) `^1.8` (or v2 beta)
- **ffmpeg with `libfdk_aac`** for talkback (AAC-ELD). Recommended: [ffmpeg-for-homebridge](https://github.com/homebridge/ffmpeg-for-homebridge)
- Network access from the Homebridge host to the VTO (HTTP CGI + RTSP)

## Install

```bash
hb-service add homebridge-dahua-vto
# or
npm install -g homebridge-dahua-vto
```

Then restart Homebridge and add the platform in the UI, or edit `config.json`.

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
          "hksv": true,
          "ffmpegPath": "/usr/local/bin/ffmpeg"
        }
      ]
    }
  ]
}
```

### Optional fields

| Field | Default | Notes |
|---|---|---|
| `rtspUrl` | auto | Full RTSP URL override |
| `rtspSubtype` | `0` | Main/sub stream if `rtspUrl` not set |
| `ssl` | `false` | HTTPS for CGI |
| `ffmpegPath` | `ffmpeg` | Path to ffmpeg-for-homebridge binary |
| `twoWayAudio` | `true` | Mic in Home → VTO speaker |
| `hksv` | `true` | Secure Video recording |
| `motionTimeoutMs` | `10000` | Auto-clear motion |

## Two-way audio

Uses the Dahua/Amcrest CGI (same as Scrypted **Doorbell Type = Dahua**):

```text
POST /cgi-bin/audio.cgi?action=postAudio&httptype=singlepart&channel=1
Content-Type: Audio/G.711A
```

In the Home app: open the camera → hold the microphone button.

## Unlock

```text
GET /cgi-bin/accessControl.cgi?action=openDoor&channel=1&UserID=101&Type=Remote
```

## Notes for publishing

1. Replace `roysbike` in `package.json` `repository` / `bugs` / `homepage`
2. Set `"author"`
3. `npm login` && `npm publish`
4. Optional: request [Homebridge verified](https://github.com/homebridge/plugins) listing after the plugin is stable

## License

MIT
