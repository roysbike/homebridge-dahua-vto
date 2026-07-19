"use strict";

const { spawn } = require("child_process");
const { createSocket } = require("dgram");
const {
  AudioBitrate,
  AudioRecordingCodecType,
  AudioRecordingSamplerate,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  CameraController,
  DoorbellController,
  H264Level,
  H264Profile,
  MediaContainerType,
  SRTPCryptoSuites,
  StreamRequestTypes,
  VideoCodecType,
} = require("../hap").getHap();
const { MP4StreamingServer } = require("./mp4Server");
const { DahuaTalkback } = require("../dahua/talkback");
const { startReturnAudio, bindUdp } = require("./returnAudio");

const H264_PROFILES = ["baseline", "main", "high"];
const H264_LEVELS = ["3.1", "3.2", "4.0"];

/**
 * Camera + Doorbell + HKSV + two-way audio (Scrypted Amcrest style).
 *
 * Outbound (VTO mic → Home): RTSP audio → Opus SRTP
 * Return   (Home → VTO speaker): Home Opus/AAC-ELD SRTP → G.711A → audio.cgi postAudio
 */
class VtoCameraDelegate {
  constructor({ config, log, dahua, getMotionActive }) {
    this.config = config;
    this.log = log;
    this.dahua = dahua;
    this.getMotionActive = getMotionActive;
    this.controller = null;
    this.pendingSessions = new Map();
    this.ongoingSessions = new Map();
    this.recordingConfiguration = undefined;
    this.recordingActive = false;
    this.mp4Server = null;
    this.talkback = new DahuaTalkback(config.dahua, log);
    this.twoWayAudio = config.twoWayAudio !== false;
  }

  handleSnapshotRequest(request, callback) {
    this.dahua
      .snapshot()
      .then((jpeg) => {
        this.log.debug(`Snapshot CGI ${jpeg.length} bytes`);
        callback(undefined, jpeg);
      })
      .catch((err) => {
        this.log.warn(`snapshot.cgi failed, fallback ffmpeg: ${err.message}`);
        this._snapshotFfmpeg(request, callback);
      });
  }

  _snapshotFfmpeg(request, callback) {
    const args = [
      "-hide_banner",
      "-y",
      "-rtsp_transport",
      "tcp",
      "-i",
      this.config.rtspUrl,
      "-frames:v",
      "1",
      "-vf",
      `scale=${request.width}:${request.height}`,
      "-f",
      "mjpeg",
      "-",
    ];
    const ff = spawn(this.config.ffmpegPath, args, { env: process.env });
    const chunks = [];
    ff.stdout.on("data", (c) => chunks.push(c));
    ff.stderr.on("data", (d) => this.log.debug(`snapshot: ${String(d).trim()}`));
    ff.on("close", (code) => {
      if (code === 0 && chunks.length) {
        callback(undefined, Buffer.concat(chunks));
      } else {
        callback(new Error(`snapshot ffmpeg exit ${code}`));
      }
    });
  }

  async prepareStream(request, callback) {
    try {
      const videoSSRC = CameraController.generateSynchronisationSource();
      const audioSSRC = CameraController.generateSynchronisationSource();
      const ipv6 = request.addressVersion === "ipv6";
      const socketType = ipv6 ? "udp6" : "udp4";

      // Same as Scrypted: bind return sockets on the connection's local address
      // and tell HomeKit via addressOverride so talkback UDP hits us.
      let sourceAddress = request.sourceAddress || "";
      if (sourceAddress.startsWith("::ffff:")) {
        sourceAddress = sourceAddress.slice(7);
      }

      const videoReturn = createSocket(socketType);
      const audioReturn = createSocket(socketType);
      videoReturn.on("error", (err) => this.log.warn(`videoReturn: ${err.message}`));
      audioReturn.on("error", (err) => this.log.warn(`audioReturn: ${err.message}`));

      const bindAddr = sourceAddress || undefined;
      const localVideoPort = await bindUdp(videoReturn, bindAddr);
      const localAudioPort = await bindUdp(audioReturn, bindAddr);

      this.log.info(
        `PrepareStream bind ${sourceAddress || "0.0.0.0"} video=${localVideoPort} audio=${localAudioPort} → ${request.targetAddress}`
      );

      this.pendingSessions.set(request.sessionID, {
        address: request.targetAddress,
        addressVersion: request.addressVersion || "ipv4",
        sourceAddress,
        videoPort: request.video.port,
        audioPort: request.audio?.port,
        localVideoPort,
        localAudioPort,
        videoReturn,
        audioReturn,
        videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
        audioSRTP: request.audio
          ? Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt])
          : null,
        videoSSRC,
        audioSSRC,
      });

      const response = {
        // Critical for talkback: HomeKit must send RTP to this host address
        addressOverride: sourceAddress || undefined,
        video: {
          port: localVideoPort,
          ssrc: videoSSRC,
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
      };

      if (request.audio) {
        response.audio = {
          port: localAudioPort,
          ssrc: audioSSRC,
          srtp_key: request.audio.srtp_key,
          srtp_salt: request.audio.srtp_salt,
        };
      }

      callback(undefined, response);
    } catch (err) {
      this.log.error(`prepareStream failed: ${err.message}`);
      callback(err);
    }
  }

  handleStreamRequest(request, callback) {
    const sessionId = request.sessionID;
    switch (request.type) {
      case StreamRequestTypes.START:
        this._startStream(request, callback);
        break;
      case StreamRequestTypes.RECONFIGURE:
        callback();
        break;
      case StreamRequestTypes.STOP:
        this._stopStream(sessionId);
        callback();
        break;
      default:
        callback();
    }
  }

  _startStream(request, callback) {
    const sessionId = request.sessionID;
    const session = this.pendingSessions.get(sessionId);
    if (!session) {
      callback(new Error("unknown session"));
      return;
    }

    const v = request.video;
    const a = request.audio;
    const profile = H264_PROFILES[v.profile] || "main";
    const level = H264_LEVELS[v.level] || "4.0";
    const videoSrtp = session.videoSRTP.toString("base64");
    const bitrate = Math.max(v.max_bit_rate || 0, 1000);
    const fps = Math.min(v.fps || 25, 25);

    // --- Video (+ optional outbound audio) in one ffmpeg ---
    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-rtsp_transport",
      "tcp",
      "-fflags",
      "+genpts+discardcorrupt",
      "-i",
      this.config.rtspUrl,
      // video
      "-map",
      "0:v:0",
      "-an",
      "-sn",
      "-dn",
      "-codec:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-color_range",
      "mpeg",
      "-profile:v",
      profile,
      "-level:v",
      level,
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-vf",
      `scale=${v.width}:${v.height}:force_original_aspect_ratio=decrease,pad=${v.width}:${v.height}:(ow-iw)/2:(oh-ih)/2`,
      "-r",
      String(fps),
      "-g",
      String(fps * 2),
      "-b:v",
      `${bitrate}k`,
      "-maxrate",
      `${bitrate}k`,
      "-bufsize",
      `${bitrate * 2}k`,
      "-payload_type",
      String(v.pt),
      "-ssrc",
      String(session.videoSSRC),
      "-f",
      "rtp",
      "-srtp_out_suite",
      "AES_CM_128_HMAC_SHA1_80",
      "-srtp_out_params",
      videoSrtp,
      `srtp://${session.address}:${session.videoPort}?rtcpport=${session.videoPort}&pkt_size=${v.mtu}`,
    ];

    // Outbound mic audio (VTO → Home). VTO often sends pcm_s16be @ 16 kHz.
    if (a && session.audioSRTP && session.audioPort) {
      const audioSrtp = session.audioSRTP.toString("base64");
      const sampleRate = (a.sample_rate || 16) * 1000;
      const audioBitrate = Math.max(a.max_bit_rate || 24, 24);
      const useOpus = a.codec === AudioStreamingCodecType.OPUS || a.codec === "OPUS";

      session._audioOutbound = {
        useOpus,
        sampleRate,
        audioBitrate,
        pt: a.pt,
        audioSrtp,
        packetTime: a.packet_time || 20,
        codec: a.codec,
      };
    }

    this.log.info(
      `Live ${v.width}x${v.height}@${fps} ${bitrate}k` +
        (a ? ` + audio(codec=${a.codec} pt=${a.pt} rate=${a.sample_rate})` : "") +
        (this.twoWayAudio ? " + talkback" : "")
    );
    this.log.debug(`ffmpeg video ${args.join(" ")}`);

    const ffVideo = spawn(this.config.ffmpegPath, args, { env: process.env });
    let started = false;
    const ack = () => {
      if (!started) {
        started = true;
        callback();
      }
    };
    ffVideo.stderr.on("data", (d) => {
      const msg = String(d);
      this.log.debug(msg.trim());
      if (/frame=|fps=|Output #0/.test(msg)) {
        ack();
      }
    });
    ffVideo.on("error", (err) => {
      if (!started) {
        callback(err);
      }
    });
    ffVideo.on("exit", (code, signal) => {
      if (!started) {
        callback(new Error(`ffmpeg video exit ${code}/${signal}`));
      } else if (code && code !== 255) {
        this.controller?.forceStopStreamingSession(sessionId);
      }
    });
    setTimeout(ack, 1500);

    // Reuse videoReturn from prepareStream for RTCP keepalive
    const socket = session.videoReturn;
    socket.on("message", () => {
      /* HomeKit RTCP / keep-alive */
    });

    const active = {
      videoProcess: ffVideo,
      audioProcess: null,
      returnAudio: null,
      socket,
      audioReturn: session.audioReturn,
      localVideoPort: session.localVideoPort,
      localAudioPort: session.localAudioPort,
    };

    // Outbound audio process
    if (session._audioOutbound) {
      const ao = session._audioOutbound;
      const audioArgs = [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-rtsp_transport",
        "tcp",
        "-fflags",
        "nobuffer+genpts+discardcorrupt+flush_packets",
        "-flags",
        "low_delay",
        "-probesize",
        "32",
        "-analyzeduration",
        "0",
        "-i",
        this.config.rtspUrl,
        "-vn",
        "-sn",
        "-dn",
        "-map",
        "0:a:0?",
        "-af",
        "aresample=async=1:min_hard_comp=0.1:first_pts=0",
        ...(ao.useOpus
          ? ["-codec:a", "libopus", "-application", "lowdelay", "-frame_duration", String(ao.packetTime || 20)]
          : ["-codec:a", "libfdk_aac", "-profile:a", "aac_eld", "-flags", "+global_header"]),
        "-ar",
        String(ao.sampleRate),
        "-ac",
        "1",
        "-b:a",
        `${ao.audioBitrate}k`,
        "-payload_type",
        String(ao.pt),
        "-ssrc",
        String(session.audioSSRC),
        "-f",
        "rtp",
        "-flush_packets",
        "1",
        "-srtp_out_suite",
        "AES_CM_128_HMAC_SHA1_80",
        "-srtp_out_params",
        ao.audioSrtp,
        `srtp://${session.address}:${session.audioPort}?rtcpport=${session.audioPort}&pkt_size=188`,
      ];
      this.log.debug(`ffmpeg audio out ${audioArgs.join(" ")}`);
      const ffAudio = spawn(this.config.ffmpegPath, audioArgs, { env: process.env });
      ffAudio.stderr.on("data", (d) => this.log.debug(`audio-out: ${String(d).trim()}`));
      ffAudio.on("exit", (code, signal) => {
        this.log.debug(`audio-out exit ${code}/${signal}`);
      });
      active.audioProcess = ffAudio;
    }

    // Two-way: Scrypted path — SRTP decrypt in Node → ffmpeg → audio.cgi G.711A
    if (this.twoWayAudio && a && session.audioSRTP && session.audioReturn) {
      startReturnAudio({
        audioReturn: session.audioReturn,
        audioSrtpKeySalt: session.audioSRTP,
        audioInfo: a,
        ffmpegPath: this.config.ffmpegPath,
        talkback: this.talkback,
        doorChannel: this.config.dahua.doorChannel,
        log: this.log,
      })
        .then((ra) => {
          active.returnAudio = ra;
        })
        .catch((err) => {
          this.log.warn(`Talkback start failed: ${err.message}`);
        });
    }

    this.ongoingSessions.set(sessionId, active);
    this.pendingSessions.delete(sessionId);
  }

  _stopStream(sessionId) {
    const pending = this.pendingSessions.get(sessionId);
    if (pending) {
      try {
        pending.videoReturn?.close();
      } catch {
        /* ignore */
      }
      try {
        pending.audioReturn?.close();
      } catch {
        /* ignore */
      }
      this.pendingSessions.delete(sessionId);
    }

    const ongoing = this.ongoingSessions.get(sessionId);
    if (!ongoing) {
      return;
    }
    try {
      ongoing.returnAudio?.stop();
    } catch {
      /* ignore */
    }
    try {
      ongoing.socket?.close();
    } catch {
      /* ignore */
    }
    try {
      ongoing.audioReturn?.close();
    } catch {
      /* ignore */
    }
    for (const proc of [ongoing.videoProcess, ongoing.audioProcess]) {
      try {
        proc?.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    this.talkback.stop().catch(() => {});
    this.ongoingSessions.delete(sessionId);
    this.log.info("Stopped stream");
  }

  updateRecordingActive(active) {
    this.recordingActive = active;
    this.log.info(`HKSV recording Active=${active}`);
  }

  updateRecordingConfiguration(configuration) {
    this.recordingConfiguration = configuration;
    this.log.info(`HKSV configuration ${configuration ? "set" : "cleared"}`);
  }

  async *handleRecordingStreamRequest(streamId) {
    const configuration = this.recordingConfiguration;
    if (!configuration) {
      return;
    }

    const profile =
      configuration.videoCodec.parameters.profile === H264Profile.HIGH
        ? "high"
        : configuration.videoCodec.parameters.profile === H264Profile.MAIN
          ? "main"
          : "baseline";
    const level =
      configuration.videoCodec.parameters.level === H264Level.LEVEL4_0
        ? "4.0"
        : configuration.videoCodec.parameters.level === H264Level.LEVEL3_2
          ? "3.2"
          : "3.1";

    const width = configuration.videoCodec.resolution[0];
    const height = configuration.videoCodec.resolution[1];
    const fps = configuration.videoCodec.resolution[2];
    const bitrate = Math.max(configuration.videoCodec.parameters.bitRate || 0, 1000);
    const iframe = configuration.videoCodec.parameters.iFrameInterval / 1000;

    const inputArgs = ["-hide_banner", "-rtsp_transport", "tcp", "-i", this.config.rtspUrl];
    const audioArgs = [
      "-acodec",
      "aac",
      "-profile:a",
      "aac_low",
      "-ar",
      "16k",
      "-b:a",
      `${configuration.audioCodec.bitrate || 32}k`,
      "-ac",
      "1",
    ];
    const videoArgs = [
      "-sn",
      "-dn",
      "-codec:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-profile:v",
      profile,
      "-level:v",
      level,
      "-vf",
      `scale=${width}:${height}`,
      "-b:v",
      `${bitrate}k`,
      "-force_key_frames",
      `expr:eq(t,n_forced*${iframe})`,
      "-r",
      String(fps),
    ];

    this.mp4Server = new MP4StreamingServer(
      this.config.ffmpegPath,
      inputArgs,
      audioArgs,
      videoArgs,
      this.log
    );

    this.log.info(`HKSV recording #${streamId} ${width}x${height}@${fps}`);
    await this.mp4Server.start();
    if (!this.mp4Server || this.mp4Server.destroyed) {
      return;
    }

    const pending = [];
    let fragments = 0;
    try {
      for await (const box of this.mp4Server.generator()) {
        pending.push(box.header, box.data);
        if (box.type === "moov" || box.type === "mdat") {
          const fragment = Buffer.concat(pending);
          pending.length = 0;
          fragments += 1;
          const isLast = fragments > 4 && !this.getMotionActive();
          yield { data: fragment, isLast };
          if (isLast) {
            break;
          }
        }
      }
    } catch (err) {
      this.log.warn(`HKSV generator: ${err.message}`);
    }
  }

  closeRecordingStream(streamId, reason) {
    this.log.info(`HKSV close #${streamId} reason=${reason}`);
    this.mp4Server?.destroy();
    this.mp4Server = null;
  }

  acknowledgeStream(streamId) {
    this.closeRecordingStream(streamId);
  }
}

function buildDoorbellController(delegate, config) {
  const recording = config.hksv.enabled
    ? {
        options: {
          prebufferLength: config.hksv.prebufferMs,
          mediaContainerConfiguration: [
            {
              type: MediaContainerType.FRAGMENTED_MP4,
              fragmentLength: config.hksv.fragmentMs,
            },
          ],
          video: {
            type: VideoCodecType.H264,
            parameters: {
              profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
              levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
            },
            resolutions: [
              [320, 180, 30],
              [320, 240, 15],
              [480, 270, 30],
              [640, 360, 30],
              [1280, 720, 30],
              [1920, 1080, 30],
            ],
          },
          audio: {
            codecs: [
              {
                type: AudioRecordingCodecType.AAC_LC,
                bitrateMode: AudioBitrate.VARIABLE,
                samplerate: AudioRecordingSamplerate.KHZ_16,
                audioChannels: 1,
              },
            ],
          },
        },
        delegate,
      }
    : undefined;

  const twoWay = config.twoWayAudio !== false;

  return new DoorbellController({
    cameraStreamCount: 2,
    delegate,
    streamingOptions: {
      supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
      video: {
        codec: {
          profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
          levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
        },
        resolutions: [
          [1280, 720, 30],
          [640, 360, 30],
          [320, 240, 15],
        ],
      },
      audio: {
        // AAC-ELD only — HomeKit talkback is AAC-ELD; keep codec consistent both ways.
        // Requires ffmpeg-for-homebridge (libfdk_aac).
        codecs: [
          {
            type: AudioStreamingCodecType.AAC_ELD,
            samplerate: AudioStreamingSamplerate.KHZ_16,
            audioChannels: 1,
          },
        ],
        twoWayAudio: twoWay,
      },
    },
    recording,
    sensors: {
      motion: true,
      occupancy: false,
    },
  });
}

module.exports = {
  VtoCameraDelegate,
  buildDoorbellController,
};
