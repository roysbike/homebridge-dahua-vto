# homebridge-dahua-vto

Homebridge plugin for **Dahua VTO** door stations (Amcrest-compatible CGI).

| | |
|---|---|
| **Tested** | [DHI-VTO2211G-WP](https://www.dahuasecurity.com/) |
| **Expected** | VTO1201G and similar models with the same HTTP CGI / RTSP API |

Built as a [dynamic platform](https://developers.homebridge.io/#/#dynamic-platform-template) with Homebridge UI settings (`config.schema.json`), aimed at [Verified By Homebridge](https://github.com/homebridge/verified) requirements.

## Features

- Live camera (H.264 via ffmpeg)
- Doorbell button notifications
- Motion sensor
- Door lock / unlock (`accessControl.cgi`)
- Two-way audio (`audio.cgi` G.711A, Scrypted Amcrest-style)
- **Card access** and **exit button** contact sensors (from CGI events)
- Optional HomeKit Secure Video (HKSV, off by default)
- **Debug logging** for testing other models and filing issues
- Auto device identity from VTO: vendor (`getVendor`), model & serial (`getSystemInfo`), firmware (`getSoftwareVersion`)

## Requirements

- [Homebridge](https://homebridge.io/) `^1.8` / `^2`
- Node.js **20** / **22** / **24** (LTS: 22 & 24 for verification)
- **ffmpeg with `libfdk_aac`** for talkback — recommended: [ffmpeg-for-homebridge](https://github.com/homebridge/ffmpeg-for-homebridge)
- LAN access to the VTO (HTTP CGI + RTSP)

## Install

Homebridge UI → **Plugins** → search `dahua-vto` → **Install**, or:

```bash
npm install -g homebridge-dahua-vto
```

Restart Homebridge, then configure the platform in the UI (or `config.json`). The plugin stays idle until a door station is configured.

## Config example

```json
{
  "platforms": [
    {
      "platform": "DahuaVTO",
      "name": "Dahua VTO",
      "debug": false,
      "cameras": [
        {
          "name": "Front Door",
          "host": "192.168.1.30",
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

### Options

| Field | Default | Notes |
|---|---|---|
| `debug` | `false` | Platform-wide verbose CGI/stream logs (also per-camera `debug`) |
| `rtspUrl` | auto | Full RTSP URL override |
| `rtspSubtype` | `0` | Main/sub stream if `rtspUrl` not set |
| `ssl` | `false` | HTTPS for CGI |
| `ffmpegPath` | `ffmpeg` | Path to ffmpeg-for-homebridge |
| `twoWayAudio` | `true` | Mic in Home → VTO speaker |
| `hksv` | `false` | Enable after live view/talkback work |
| `accessoryId` | `name` | Stable HomeKit UUID seed — do not change after pairing |
| `motionTimeoutMs` | `10000` | Auto-clear motion |
| `enableMotionDetect` | `true` | Auto-enable VTO MotionDetect via CGI at start |
| `cardSensor` | `true` | Contact «Card Access» on card/fob |
| `exitSensor` | `true` | Contact «Exit Button» |
| `exitAlarmIndex` | `3` | AlarmLocal index for exit (VTO2111D/2211G) |
| `sensorPulseMs` | `3000` | How long contact stays “open” |
| `manufacturer` | auto | Override; empty = getVendor from VTO |
| `model` | auto | Override; empty = deviceType from VTO |
| `serialNumber` | auto | Override; empty = serial from getSystemInfo |
| `firmware` | auto | Override; empty = real version from getSoftwareVersion |

If Home still shows the VTO **IP as serial** after update, remove the cached accessory in Homebridge UI and re-pair (HomeKit caches serial at pairing time).

## Supported models

CGI API is shared across many Dahua / Amcrest door stations.

| Model | Status |
|---|---|
| **DHI-VTO2211G-WP** | Tested |
| **VTO1201G** and similar | Expected to work (same CGI) |
| Other VTO / Amcrest intercoms | Likely — enable **Debug** and [open an issue](https://github.com/roysbike/homebridge-dahua-vto/issues) if something fails |

### Testing another model

1. Set `"debug": true` on the platform (or on the camera entry).
2. Restart Homebridge, ring the button, open live view, try unlock / talkback.
3. Copy the Homebridge log lines tagged `[DEBUG]` (especially `Unhandled CGI event` / `Event …`).
4. Open a [GitHub issue](https://github.com/roysbike/homebridge-dahua-vto/issues) with: **model name**, firmware if known, and the debug log.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ECONNREFUSED` on event stream | `host` must be the **VTO IP**, not the Homebridge host |
| No talkback / garbled audio | Use ffmpeg-for-homebridge (`libfdk_aac`); keep `twoWayAudio: true` |
| No doorbell on another model | Enable `debug`, ring button, file an issue with CGI event codes |
| Walk-by motion / HKSV never records | Keep `enableMotionDetect: true` (default). Or enable Motion/SMD in VTO UI. With `debug=true` look for `VideoMotion` / `SmartMotionHuman`. |
| Duplicate accessories after rename | Set fixed `accessoryId`; remove stale accessories in UI |

## License

MIT
