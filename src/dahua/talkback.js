"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { getDigestAuthorization } = require("../util/digest");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Read exactly `n` bytes from a stream (Scrypted readLength).
 */
function readLength(stream, n) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let got = 0;

    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", onError);
      stream.off("end", onEnd);
      stream.off("close", onEnd);
    };

    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("stream ended"));
    };
    const onData = (chunk) => {
      chunks.push(chunk);
      got += chunk.length;
      if (got >= n) {
        cleanup();
        const buf = Buffer.concat(chunks);
        const out = buf.subarray(0, n);
        const rest = buf.subarray(n);
        if (rest.length) {
          stream.unshift(rest);
        }
        resolve(out);
      }
    };

    stream.on("error", onError);
    stream.on("end", onEnd);
    stream.on("close", onEnd);
    stream.on("data", onData);
  });
}

/**
 * Dahua talkback — Scrypted Amcrest Dahua Doorbell:
 * POST audio.cgi?action=postAudio&httptype=singlepart&channel=1
 * Content-Type: Audio/G.711A
 * 1024-byte chunks, realtime ≤ 8000 B/s (clean speaker, no flood distortion)
 */
class DahuaTalkback {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this._abort = null;
    this._active = false;
    this._bytesSent = 0;
    this._req = null;
    this._authHeader = null;
    this._authPromise = null;
  }

  get active() {
    return this._active;
  }

  /** Prefetch digest so first mic packet opens POST instantly */
  prepareAuth(channel = this.config.doorChannel || 1) {
    if (this._authPromise) {
      return this._authPromise;
    }
    const ch = Number(channel) || 1;
    const urlString =
      `${this.config.baseUrl}audio.cgi` +
      `?action=postAudio&httptype=singlepart&channel=${ch}`;
    const challengeUrl = `${this.config.baseUrl}global.cgi?action=getCurrentTime`;

    this._authPromise = getDigestAuthorization({
      challengeUrl,
      method: "POST",
      targetUrl: urlString,
      username: this.config.username,
      password: this.config.password,
      timeoutMs: 5000,
    })
      .then((h) => {
        this._authHeader = h || "";
        this.log.info("Talkback: digest ready");
        return this._authHeader;
      })
      .catch((err) => {
        this.log.warn(`Talkback digest: ${err.message}`);
        this._authHeader = "";
        return "";
      });

    return this._authPromise;
  }

  async start(channel = this.config.doorChannel || 1) {
    await this.stop();
    await this.prepareAuth(channel);

    const ch = Number(channel) || 1;
    const urlString =
      `${this.config.baseUrl}audio.cgi` +
      `?action=postAudio&httptype=singlepart&channel=${ch}`;

    const url = new URL(urlString);
    const transport = url.protocol === "https:" ? https : http;
    this._active = true;
    this._bytesSent = 0;

    const headers = {
      "Content-Type": "Audio/G.711A",
      "Content-Length": "9999999",
      Connection: "close",
    };
    if (this._authHeader) {
      headers.Authorization = this._authHeader;
    }

    this.log.info(`Talkback POST ${urlString}`);

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers,
        rejectUnauthorized: false,
      },
      (res) => {
        this.log.info(`Talkback HTTP ${res.statusCode}`);
        res.resume();
      }
    );
    this._req = req;

    req.on("socket", (sock) => sock.setNoDelay(true));
    req.on("error", (err) => {
      if (this._active) {
        this.log.warn(`Talkback request error: ${err.message}`);
      }
      this._active = false;
    });

    this._abort = () => {
      try {
        req.end();
        req.destroy();
      } catch {
        /* ignore */
      }
    };

    this.log.info("Talkback: audio.cgi opened");
    return this;
  }

  /**
   * Scrypted Amcrest loop: readLength(1024) → POST
   * Wall-clock ≤ 8000 B/s prevents VTO speaker distortion.
   */
  async pumpFrom(stream) {
    let t0 = 0;
    try {
      while (this._active && this._req && !this._req.destroyed) {
        const data = await readLength(stream, 1024);
        if (!t0) {
          t0 = Date.now();
        }

        const due = t0 + (this._bytesSent / 8000) * 1000;
        const wait = due - Date.now();
        if (wait > 2) {
          await sleep(wait);
        }

        if (!this._active || this._req.destroyed) {
          break;
        }
        this._req.write(data);
        this._bytesSent += data.length;
      }
    } catch (err) {
      if (this._active) {
        this.log.debug(`Talkback pump end: ${err.message}`);
      }
    } finally {
      this.log.info(`Talkback pump done, sent ${this._bytesSent} bytes`);
    }
  }

  async stop() {
    this._active = false;
    if (this._abort) {
      this._abort();
      this._abort = null;
    }
    this._req = null;
    // keep cached digest for next talk session in same process
  }
}

module.exports = {
  DahuaTalkback,
  readLength,
};
