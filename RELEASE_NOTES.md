# homebridge-dahua-vto 1.0.1

First **stable** release of the Homebridge plugin for Dahua VTO door stations.

## Highlights
- 📷 Live camera in Apple Home
- 🔔 Doorbell + motion events
- 🔓 Remote door unlock
- 🎙️ Two-way audio (Scrypted Amcrest / `audio.cgi` G.711A)
- 🎥 Optional HomeKit Secure Video

Tested with **Dahua VTO2111D** on **Homebridge 2.1** / HAP 2.1.

## Install
```bash
npm install -g homebridge-dahua-vto
```
Or Homebridge UI → Plugins → **Dahua VTO**.

## Important
- **Disable Child Bridge** for this plugin (HB 2.x camera child bridges get SIGTERM loops).
- Use **ffmpeg-for-homebridge** so AAC-ELD talkback works (`libfdk_aac`).
- Set `host` to the **VTO IP**, not the Homebridge host.

## Example config
```json
{
  "platform": "DahuaVTO",
  "name": "Dahua VTO",
  "cameras": [{
    "name": "Front Door",
    "host": "192.168.80.8",
    "username": "admin",
    "password": "YOUR_PASSWORD",
    "twoWayAudio": true,
    "hksv": false,
    "ffmpegPath": "/usr/local/bin/ffmpeg"
  }]
}
```

Full notes: see [CHANGELOG.md](./CHANGELOG.md).
