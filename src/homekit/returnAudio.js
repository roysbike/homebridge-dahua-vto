"use strict";

const { spawn } = require("child_process");
const { createSocket } = require("dgram");
const { AudioStreamingCodecType, AudioStreamingSamplerate } = require("../hap").getHap();

/**
 * AAC-ELD AudioSpecificConfig — Scrypted createReturnAudioSdp
 */
function aacEldConfigHex(sampleRateEnum) {
  let csd = Buffer.from("F8F0212C00BC00", "hex");
  let b = csd[1];
  b &= 0b11100001;
  const fi =
    sampleRateEnum === AudioStreamingSamplerate.KHZ_8
      ? 11
      : sampleRateEnum === AudioStreamingSamplerate.KHZ_24
        ? 6
        : 8;
  b |= fi << 1;
  csd[1] = b;
  return csd.toString("hex").toUpperCase();
}

function createPlainReturnSdp(audioInfo, rtpPort) {
  const isOpus =
    audioInfo.codec === AudioStreamingCodecType.OPUS || audioInfo.codec === "OPUS";
  const csd = aacEldConfigHex(audioInfo.sample_rate);
  const lines = [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=HomeKit Audio Talkback",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
    `m=audio ${rtpPort} RTP/AVP 110`,
    "b=AS:24",
  ];
  if (isOpus) {
    lines.push("a=rtpmap:110 opus/24000/2", "a=fmtp:110 minptime=10;useinbandfec=1");
  } else {
    lines.push(
      "a=rtpmap:110 MPEG4-GENERIC/16000/1",
      `a=fmtp:110 profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=${csd}`
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

function bindUdp(socket, address) {
  return new Promise((resolve, reject) => {
    const onErr = (err) => {
      socket.removeListener("listening", onListen);
      reject(err);
    };
    const onListen = () => {
      socket.removeListener("error", onErr);
      resolve(socket.address().port);
    };
    socket.once("error", onErr);
    socket.once("listening", onListen);
    if (address) {
      socket.bind(0, address);
    } else {
      socket.bind(0);
    }
  });
}

/**
 * Home → VTO talkback aligned with Scrypted:
 * HomeKit plugin: SRTP decrypt → local RTP
 * Amcrest startIntercom: ffmpeg → pcm_alaw pipe:3 → 1024 → audio.cgi
 */
async function startReturnAudio({
  audioReturn,
  audioSrtpKeySalt,
  audioInfo,
  ffmpegPath,
  talkback,
  doorChannel,
  log,
}) {
  const { SrtpSession } = await import("rtp-packet");
  const key = audioSrtpKeySalt.subarray(0, 16);
  const salt = audioSrtpKeySalt.subarray(16, 30);
  const srtp = new SrtpSession(key, salt);

  const expectedPt = Number(audioInfo.pt) || 110;
  const isOpus =
    audioInfo.codec === AudioStreamingCodecType.OPUS || audioInfo.codec === "OPUS";

  const probe = createSocket("udp4");
  const listenPort = await bindUdp(probe, "127.0.0.1");
  await new Promise((resolve) => probe.close(resolve));

  const forward = createSocket("udp4");
  try {
    forward.setSendBufferSize(256 * 1024);
  } catch {
    /* ignore */
  }

  let rtpCount = 0;
  let decryptFail = 0;
  let closed = false;
  let pumpStarted = false;

  // Prefetch digest only — open audio.cgi on first mic RTP (like Scrypted startIntercom)
  talkback.prepareAuth(doorChannel);

  // Scrypted Amcrest ffmpeg output args (exact)
  const decodeArgs = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-protocol_whitelist",
    "pipe,udp,rtp,file",
    "-fflags",
    "nobuffer",
    "-flags",
    "low_delay",
    "-probesize",
    "32",
    "-analyzeduration",
    "0",
    "-f",
    "sdp",
    ...(isOpus ? [] : ["-c:a", "libfdk_aac"]),
    "-i",
    "pipe:0",
    // Amcrest Dahua Doorbell:
    "-vn",
    "-acodec",
    "pcm_alaw",
    "-ac",
    "1",
    "-ar",
    "8000",
    "-sample_fmt",
    "s16",
    "-f",
    "alaw",
    "pipe:3",
  ];

  const sdp = createPlainReturnSdp(audioInfo, listenPort);
  log.info(
    `Talkback Amcrest path: ${isOpus ? "opus" : "aac-eld"} → G.711A pipe:3 → audio.cgi`
  );
  log.debug(`Talkback SDP:\n${sdp}`);

  const ffReturn = spawn(ffmpegPath, decodeArgs, {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  ffReturn.stdin.write(sdp);
  ffReturn.stdin.end();

  const alawPipe = ffReturn.stdio[3];

  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    audioReturn.removeListener("message", onMessage);
    try {
      forward.close();
    } catch {
      /* ignore */
    }
    try {
      ffReturn.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    talkback.stop().catch(() => {});
  };

  const startPump = async () => {
    if (pumpStarted || closed) {
      return;
    }
    pumpStarted = true;
    try {
      await talkback.start(doorChannel);
      if (closed) {
        return;
      }
      log.info("Talkback: Amcrest pump 1024 @ 8 kHz");
      await talkback.pumpFrom(alawPipe);
    } catch (err) {
      log.error(`Talkback Amcrest pump failed: ${err.message}`);
    }
  };

  ffReturn.stderr.on("data", (d) => {
    const msg = String(d).trim();
    if (msg) {
      log.debug(`talkback-ff: ${msg}`);
    }
  });

  ffReturn.on("exit", (code, signal) => {
    log.info(`Talkback ffmpeg exit code=${code} signal=${signal} rtp=${rtpCount}`);
  });

  const onMessage = (msg, rinfo) => {
    if (closed || msg.length < 12) {
      return;
    }
    const rawPt = msg[1] & 0x7f;
    if (rawPt >= 200 && rawPt <= 207) {
      return;
    }

    let decrypted;
    try {
      decrypted = srtp.decryptRtp(msg);
    } catch {
      decryptFail += 1;
      return;
    }
    if (!decrypted) {
      decryptFail += 1;
      return;
    }

    const pt = decrypted[1] & 0x7f;
    if (pt !== expectedPt && pt !== 110) {
      return;
    }

    rtpCount += 1;
    if (rtpCount === 1) {
      log.info(`Talkback: first SRTP from ${rinfo.address}:${rinfo.port} pt=${pt}`);
      // Scrypted: startIntercom only after first return-audio RTP
      startPump();
    }

    if (pt !== 110) {
      decrypted = Buffer.from(decrypted);
      decrypted[1] = (decrypted[1] & 0x80) | 110;
    }

    forward.send(decrypted, listenPort, "127.0.0.1");
  };

  audioReturn.on("message", onMessage);
  log.info("Talkback listening (Scrypted/Amcrest) — hold mic in Home");

  setTimeout(() => {
    if (!closed && rtpCount === 0) {
      log.warn(`Talkback silent — hold mic. decryptFails=${decryptFail}`);
    }
  }, 10000);

  return {
    stop: cleanup,
    process: ffReturn,
    getStats: () => ({ rtpCount, decryptFail }),
  };
}

module.exports = {
  startReturnAudio,
  bindUdp,
  aacEldConfigHex,
  createPlainReturnSdp,
};
