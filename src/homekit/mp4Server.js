"use strict";

const { spawn } = require("child_process");
const { once } = require("events");
const { createServer } = require("net");

/**
 * FFmpeg → fragmented MP4 over TCP (for HKSV).
 */
class MP4StreamingServer {
  constructor(ffmpegPath, inputArgs, audioArgs, videoArgs, log) {
    this.ffmpegPath = ffmpegPath;
    this.args = [...inputArgs, ...audioArgs, "-f", "mp4", ...videoArgs, "-fflags", "+genpts", "-reset_timestamps", "1", "-movflags", "frag_keyframe+empty_moov+default_base_moof"];
    this.log = log;
    this.server = createServer(this._onConnection.bind(this));
    this.socket = null;
    this.child = null;
    this.destroyed = false;
    this._connectResolve = null;
    this.connectPromise = new Promise((resolve) => {
      this._connectResolve = resolve;
    });
  }

  async start() {
    const listening = once(this.server, "listening");
    this.server.listen(0, "127.0.0.1");
    await listening;
    if (this.destroyed) {
      return;
    }
    const port = this.server.address().port;
    this.args.push(`tcp://127.0.0.1:${port}`);
    this.log.debug(`HKSV ffmpeg ${this.ffmpegPath} ${this.args.join(" ")}`);
    this.child = spawn(this.ffmpegPath, this.args, {
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.child.stderr.on("data", (d) => this.log.debug(`HKSV ffmpeg: ${String(d).trim()}`));
    this.child.on("exit", (code, signal) => {
      this.log.debug(`HKSV ffmpeg exit code=${code} signal=${signal}`);
    });
  }

  destroy() {
    this.destroyed = true;
    try {
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    try {
      this.child?.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    try {
      this.server.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.child = null;
  }

  _onConnection(socket) {
    this.server.close();
    this.socket = socket;
    this._connectResolve?.();
  }

  async *generator() {
    await this.connectPromise;
    if (!this.socket) {
      throw new Error("HKSV socket missing");
    }
    while (!this.destroyed) {
      const header = await this._read(8);
      const length = header.readInt32BE(0) - 8;
      const type = header.subarray(4).toString();
      const data = await this._read(Math.max(length, 0));
      yield { header, length, type, data };
    }
  }

  _read(length) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.destroyed) {
        reject(new Error("FFMPEG socket closed"));
        return;
      }
      if (!length) {
        resolve(Buffer.alloc(0));
        return;
      }
      const tryRead = () => {
        const value = this.socket.read(length);
        if (value) {
          cleanup();
          resolve(value);
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`FFMPEG socket closed during read (${length})`));
      };
      const cleanup = () => {
        this.socket?.off("readable", tryRead);
        this.socket?.off("close", onClose);
        this.socket?.off("error", onClose);
      };
      this.socket.on("readable", tryRead);
      this.socket.on("close", onClose);
      this.socket.on("error", onClose);
      tryRead();
    });
  }
}

module.exports = {
  MP4StreamingServer,
};
