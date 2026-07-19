# homebridge-dahua-vto v1.0.1

First **stable** release — Dahua VTO door stations in Apple Home via Homebridge.

Tested with **Dahua VTO2111D** · Homebridge **2.1** · HAP **2.1**

---

## What it does

| Feature | Details |
|--------|---------|
| 📷 **Live camera** | H.264 stream to Home via ffmpeg |
| 🔔 **Doorbell** | Button press → HomeKit notification (`ringDoorbell`) |
| 🏃 **Motion** | From Dahua event stream (`VideoMotion`) |
| 🔓 **Door unlock** | Lock tile → `accessControl.cgi` openDoor |
| 🎙️ **Two-way audio** | Same path as Scrypted Amcrest / Dahua (`audio.cgi` G.711A) |
| 🎥 **HKSV** | Optional HomeKit Secure Video (off by default) |

---

## Install

```bash
npm install -g homebridge-dahua-vto
```

Or Homebridge UI → Plugins → search **Dahua VTO** → Install → Restart.

### Config example

```json
{
  "platform": "DahuaVTO",
  "name": "Dahua VTO",
  "cameras": [
    {
      "name": "Front Door",
      "host": "192.168.80.8",
      "username": "admin",
      "password": "YOUR_PASSWORD",
      "twoWayAudio": true,
      "hksv": false,
      "ffmpegPath": "/usr/local/bin/ffmpeg"
    }
  ]
}
```

---

## Requirements

- Homebridge `^1.8` / `^2`
- Node.js 18 / 20 / 22 / 24
- **[ffmpeg-for-homebridge](https://github.com/homebridge/ffmpeg-for-homebridge)** (`libfdk_aac` for AAC-ELD talkback)
- VTO reachable on LAN (HTTP CGI + RTSP)

### Important

- **Child Bridge must be OFF** — on Homebridge 2.x, camera/doorbell plugins in a child bridge often die with `SIGTERM`. Run in the **main** bridge.
- `host` = **VTO IP**, not the Homebridge host.
- Doorbell notifications need a HomeKit hub (HomePod / Apple TV) and notifications enabled in the Home app.

---

## How doorbell / unlock / talkback work

- **Events:** `eventManager.cgi?action=attach&codes=[All]` — same as Scrypted Amcrest  
- **Ring:** Dahua codes like `CallNoAnswered`, `_CallNoAnswer_`, `_DoTalkAction_` → `ringDoorbell()`  
- **Unlock:** `accessControl.cgi?action=openDoor&channel=1&UserID=101&Type=Remote`  
- **Talkback:** Home mic → AAC-ELD → G.711A → `POST audio.cgi?action=postAudio&httptype=singlepart` (1024-byte chunks @ ≤ 8 kB/s)

---

## Changelog since betas

- Digest auth for `audio.cgi` fixed (no hanging empty POST)
- Talkback aligned with Scrypted Amcrest quality/timing
- Stable accessory UUID (`name` / `accessoryId`)
- No auto-unregister at startup (was restarting child bridges)
- Explicit Child Bridge warning

Full history: [CHANGELOG.md](https://github.com/roysbike/homebridge-dahua-vto/blob/main/CHANGELOG.md)

---

**npm:** https://www.npmjs.com/package/homebridge-dahua-vto  
**Repo:** https://github.com/roysbike/homebridge-dahua-vto
