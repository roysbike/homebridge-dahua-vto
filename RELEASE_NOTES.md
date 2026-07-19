# homebridge-dahua-vto v1.0.2

Homebridge plugin for **Dahua VTO** door stations (Amcrest-compatible CGI).

## Supported models

| Model | Status |
|---|---|
| **DHI-VTO2211G-WP** | Tested |
| **VTO1201G** and similar | Expected (same CGI API) |
| Other Dahua / Amcrest VTOs | Likely — enable **Debug** and open an issue with logs |

## Features

- Live camera (H.264 via ffmpeg)
- Doorbell notifications + motion
- Door unlock (`accessControl.cgi`)
- Two-way audio (`audio.cgi` G.711A)
- Optional HKSV (off by default)
- Homebridge UI settings schema
- **Debug logging** for model compatibility reports

## Requirements

- Homebridge `^1.8` / `^2`
- Node.js 20 / 22 / 24
- [ffmpeg-for-homebridge](https://github.com/homebridge/ffmpeg-for-homebridge) (`libfdk_aac`) for talkback
- **Child Bridge OFF** (run in the main bridge)

## Install

```text
Homebridge UI → Plugins → homebridge-dahua-vto → Install
```

or `npm install -g homebridge-dahua-vto`

## Config

```json
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
      "model": "DHI-VTO2211G-WP",
      "twoWayAudio": true,
      "hksv": false
    }
  ]
}
```

Set `"debug": true` when testing another model, then attach `[DEBUG]` logs to a [GitHub issue](https://github.com/roysbike/homebridge-dahua-vto/issues).

## Changes in 1.0.2

- Verified-oriented cleanup (no publish scripts in package)
- Debug option + unhandled CGI event logging
- Model documentation (DHI-VTO2211G-WP / VTO1201G+)
- Safer event parsing

Full changelog: see `CHANGELOG.md`.
