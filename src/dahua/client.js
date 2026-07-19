"use strict";

const EventEmitter = require("events");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const crypto = require("crypto");
const { digestRequest } = require("../util/digest");

/**
 * Dahua VTO client — CGI aligned with Scrypted Amcrest plugin:
 * https://github.com/koush/scrypted/blob/main/plugins/amcrest/src/amcrest-api.ts
 *
 * unlock:
 *   /cgi-bin/accessControl.cgi?action=openDoor&channel=1&UserID=101&Type=Remote
 * snapshot:
 *   /cgi-bin/snapshot.cgi
 * events:
 *   /cgi-bin/eventManager.cgi?action=attach&codes=[All]
 */
class DahuaClient extends EventEmitter {
  constructor(config, log) {
    super();
    this.config = config;
    this.log = log;
    this._stopped = false;
    this._req = null;
    this._unlockUntil = new Map(); // channel -> timestamp
    this._unlockInflight = new Map();
  }

  async openDoor(channel = this.config.doorChannel) {
    const ch = Number(channel) || 1;
    const now = Date.now();
    const until = this._unlockUntil.get(ch) || 0;
    if (until > now) {
      this.log.info(`Door ${ch}: unlock ignored (cooldown ${Math.ceil((until - now) / 1000)}s)`);
      return "OK (cooldown)";
    }
    if (this._unlockInflight.get(ch)) {
      this.log.info(`Door ${ch}: unlock already in flight`);
      return this._unlockInflight.get(ch);
    }

    // Same URL as Scrypted AmcrestCameraClient.unlock()
    const url =
      `${this.config.baseUrl}accessControl.cgi` +
      `?action=openDoor&channel=${ch}&UserID=101&Type=Remote`;

    const promise = (async () => {
      this.log.info(`Opening door channel ${ch}`);
      const res = await digestRequest(url, {
        username: this.config.username,
        password: this.config.password,
      });

      const body = String(res.body || "").trim();
      // VTO returns HTTP 400 "Bad Request" if unlock is requested again
      // while the strike is still held — treat as success during cooldown.
      if (res.statusCode === 400 || /Bad Request/i.test(body)) {
        this.log.warn(`Door ${ch}: VTO rejected duplicate unlock (already open): ${body}`);
        this._unlockUntil.set(ch, Date.now() + this.config.unlockSeconds * 1000);
        this.emit("doorOpened", { door: ch, duplicate: true });
        return "OK (duplicate)";
      }

      if (res.statusCode < 200 || res.statusCode >= 300 || !/OK/i.test(body)) {
        throw new Error(`openDoor failed: HTTP ${res.statusCode} ${body}`);
      }

      this._unlockUntil.set(ch, Date.now() + this.config.unlockSeconds * 1000);
      this.log.info(`Door ${ch} open OK: ${body}`);
      this.emit("doorOpened", { door: ch });
      return body;
    })();

    this._unlockInflight.set(ch, promise);
    try {
      return await promise;
    } finally {
      this._unlockInflight.delete(ch);
    }
  }

  async closeDoor(channel = this.config.doorChannel) {
    const ch = Number(channel) || 1;
    const url =
      `${this.config.baseUrl}accessControl.cgi` +
      `?action=closeDoor&channel=${ch}&UserID=101&Type=Remote`;
    const res = await digestRequest(url, {
      username: this.config.username,
      password: this.config.password,
    });
    return String(res.body || "").includes("OK");
  }

  /** JPEG snapshot via CGI — preferred over RTSP (Scrypted jpegSnapshot). */
  async snapshot() {
    const url = `${this.config.baseUrl}snapshot.cgi`;
    const res = await digestRequest(url, {
      username: this.config.username,
      password: this.config.password,
      responseType: "buffer",
      timeoutMs: 10000,
    });
    if (res.statusCode < 200 || res.statusCode >= 300 || !Buffer.isBuffer(res.body) || !res.body.length) {
      throw new Error(`snapshot.cgi failed: HTTP ${res.statusCode}`);
    }
    return res.body;
  }

  startEventStream() {
    this._stopped = false;
    this._connectEvents();
  }

  stop() {
    this._stopped = true;
    if (this._req) {
      this._req.destroy();
      this._req = null;
    }
  }

  _connectEvents() {
    if (this._stopped) {
      return;
    }

    const codes = encodeURIComponent(`[${this.config.eventCodes}]`);
    const urlString = `${this.config.baseUrl}eventManager.cgi?action=attach&codes=${codes}`;
    const url = new URL(urlString);
    const transport = url.protocol === "https:" ? https : http;

    this.log.info(`Connecting event stream: ${url.hostname}`);

    const start = (authHeader) => {
      const req = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: {
            ...(authHeader ? { Authorization: authHeader } : {}),
            Connection: "keep-alive",
          },
          rejectUnauthorized: false,
        },
        (res) => {
          if (res.statusCode === 401) {
            const challenge = res.headers["www-authenticate"];
            res.resume();
            if (!challenge) {
              this._scheduleReconnect("401 without challenge");
              return;
            }
            const auth = buildDigestAuth({
              challenge,
              method: "GET",
              url,
              username: this.config.username,
              password: this.config.password,
            });
            start(auth);
            return;
          }

          if (res.statusCode !== 200) {
            this._scheduleReconnect(`event HTTP ${res.statusCode}`);
            res.resume();
            return;
          }

          this.log.info("Event stream connected");
          this.emit("connected");
          res.socket?.setKeepAlive(true);

          let buffer = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            buffer += chunk;
            const parts = buffer.split(/\r?\n\r?\n/);
            buffer = parts.pop() || "";
            for (const part of parts) {
              this._handleEventChunk(part);
            }
          });
          res.on("end", () => this._scheduleReconnect("event stream ended"));
          res.on("error", (err) => this._scheduleReconnect(err.message));
        }
      );

      this._req = req;
      req.on("error", (err) => this._scheduleReconnect(err.message));
      req.setTimeout(0);
      req.end();
    };

    start(null);
  }

  _handleEventChunk(raw) {
    const text = raw.trim();
    if (!text || text.startsWith("--") || text.startsWith("HTTP/")) {
      return;
    }

    const codeMatch = text.match(/Code=([^;]+)/i);
    const actionMatch = text.match(/action=([^;]+)/i);
    if (!codeMatch) {
      return;
    }

    const code = codeMatch[1].trim();
    const action = actionMatch ? actionMatch[1].trim() : "Pulse";
    let data = {};
    const dataMatch = text.match(/data=(\{[\s\S]*\})/i);
    if (dataMatch) {
      try {
        data = JSON.parse(dataMatch[1]);
      } catch {
        data = { raw: dataMatch[1] };
      }
    }

    const event = { Code: code, Action: action, Data: data, raw: text };
    this.log.debug(`Event ${code}/${action}`);
    this.emit("event", event);

    // Scrypted AmcrestEvent mappings for Dahua doorbell
    if (code === "VideoMotion" && action === "Start") {
      this.emit("motion", true, event);
    } else if (code === "VideoMotion" && action === "Stop") {
      this.emit("motion", false, event);
    } else if (code === "CallNoAnswered" && action === "Start") {
      this.emit("doorbell", event);
      this.emit("motion", true, event);
    } else if (code === "_CallNoAnswer_" && action === "Pulse") {
      this.emit("doorbell", event);
    } else if (code === "_DoTalkAction_" && (action === "Invite" || action === "Pulse")) {
      this.emit("doorbell", event);
    } else if (code === "BackKeyLight") {
      const state = data?.State;
      if (state === 1 || state === 8 || state === "1" || state === "8") {
        this.emit("doorbell", event);
      }
    } else if (code === "AccessControl") {
      this.emit("accessControl", event);
    }
  }

  _scheduleReconnect(reason) {
    if (this._stopped) {
      return;
    }
    this.log.warn(`Event stream reconnect in 5s (${reason})`);
    this._req = null;
    setTimeout(() => this._connectEvents(), 5000);
  }
}

function buildDigestAuth({ challenge, method, url, username, password }) {
  const parsed = {};
  const body = String(challenge).replace(/^Digest\s+/i, "");
  for (const part of body.match(/(?:[a-zA-Z0-9_]+)=(?:"[^"]*"|[^,]*)/g) || []) {
    const idx = part.indexOf("=");
    const key = part.slice(0, idx);
    let val = part.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    parsed[key] = val;
  }

  const realm = parsed.realm || "";
  const nonce = parsed.nonce || "";
  const qop = (parsed.qop || "").split(",")[0].trim();
  const opaque = parsed.opaque;
  const nc = "00000001";
  const cnonce = crypto.randomBytes(8).toString("hex");
  const uri = `${url.pathname}${url.search}`;
  const ha1 = crypto.createHash("md5").update(`${username}:${realm}:${password}`).digest("hex");
  const ha2 = crypto.createHash("md5").update(`${method}:${uri}`).digest("hex");
  const response = qop
    ? crypto.createHash("md5").update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest("hex")
    : crypto.createHash("md5").update(`${ha1}:${nonce}:${ha2}`).digest("hex");

  const parts = [
    `Digest username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];
  if (qop) {
    parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  }
  if (opaque) {
    parts.push(`opaque="${opaque}"`);
  }
  return parts.join(", ");
}

module.exports = {
  DahuaClient,
};
