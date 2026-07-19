# homebridge-dahua-vto v1.0.4

Homebridge plugin for **Dahua / Amcrest-compatible VTO** door stations.

## What's new

### 1.0.4
- Verified fix: `homebridge` is only in `devDependencies` (not `peerDependencies`)

### Also since 1.0.2
- Display name: **Homebridge Dahua VTO**
- Removed Child Bridge warnings (works stably with Child Bridge)
- Platform / per-camera **`debug`** logging for other models + GitHub issues
- Documented models: **DHI-VTO2211G-WP** (tested), **VTO1201G** and similar

## Features

- Live camera (H.264 via ffmpeg)
- Doorbell notifications + motion
- Door unlock (`accessControl.cgi`)
- Two-way audio (`audio.cgi` G.711A)
- Optional HKSV (off by default)
- Homebridge UI settings (`config.schema.json`)

## Supported models

| Model | Status |
|---|---|
| **DHI-VTO2211G-WP** | Tested |
| **VTO1201G** and similar | Expected (same CGI API) |
| Other Dahua / Amcrest VTOs | Enable **Debug** and [open an issue](https://github.com/roysbike/homebridge-dahua-vto/issues) with logs |

## Requirements

- Homebridge `^1.8` / `^2`
- Node.js 20 / 22 / 24
- [ffmpeg-for-homebridge](https://github.com/homebridge/ffmpeg-for-homebridge) (`libfdk_aac`) for talkback

## Install

Homebridge UI → Plugins → `homebridge-dahua-vto` → Install  

or: `npm install -g homebridge-dahua-vto`

## Config example

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

Full changelog: [CHANGELOG.md](https://github.com/roysbike/homebridge-dahua-vto/blob/main/CHANGELOG.md)
