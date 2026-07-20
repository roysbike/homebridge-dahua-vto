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

  /**
   * Real device identity from magicBox.cgi (getSystemInfo + getSoftwareVersion).
   * Example getSystemInfo:
   *   deviceType=VTO2111D-P-S2
   *   serialNumber=7E02BF7PAJD7071
   *   hardwareVersion=1.00
   */
  async getDeviceInfo() {
    const sys = await this._magicBox("getSystemInfo");
    let soft = {};
    try {
      soft = await this._magicBox("getSoftwareVersion");
    } catch (err) {
      this.log.debug(`getSoftwareVersion: ${err.message}`);
    }

    const model = sys.deviceType || sys.updateSerial || "";
    const serialNumber = sys.serialNumber || "";
    const hardwareRevision = sys.hardwareVersion || "";
    const firmware =
      soft.version || soft.Version || soft.softwareVersion || hardwareRevision || "";

    const info = {
      manufacturer: "Dahua",
      model: String(model).trim(),
      serialNumber: String(serialNumber).trim(),
      hardwareRevision: String(hardwareRevision).trim(),
      firmware: normalizeFirmware(firmware),
      raw: { ...sys, ...soft },
    };
    this.log.debug(`Device info: ${JSON.stringify(info.raw)}`);
    return info;
  }

  async _magicBox(action) {
    const url = `${this.config.baseUrl}magicBox.cgi?action=${encodeURIComponent(action)}`;
    const res = await digestRequest(url, {
      username: this.config.username,
      password: this.config.password,
      timeoutMs: 8000,
    });
    const body = String(res.body || "");
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`magicBox ${action}: HTTP ${res.statusCode} ${body.slice(0, 120)}`);
    }
    return parseDahuaKeyValues(body);
  }

  /**
   * Check if VTO has motion detection enabled (needed for HKSV / HomeKit motion).
   * Many VTOs leave MotionDetect off — then eventManager never sends VideoMotion.
   */
  async getMotionDetectStatus() {
    const url = `${this.config.baseUrl}configManager.cgi?action=getConfig&name=MotionDetect`;
    try {
      const res = await digestRequest(url, {
        username: this.config.username,
        password: this.config.password,
        timeoutMs: 8000,
      });
      const body = String(res.body || "");
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return { ok: false, enabled: null, raw: body.slice(0, 200) };
      }
      const props = parseDahuaKeyValues(body);
      // table.MotionDetect[0].Enable=true  or  MotionDetect[0].Enable=true
      let enabled = null;
      for (const [k, v] of Object.entries(props)) {
        if (/MotionDetect\[\d+\]\.Enable$/i.test(k) || /\.Enable$/i.test(k) && /MotionDetect/i.test(k)) {
          enabled = v === "true" || v === "1" || v === true;
          break;
        }
      }
      if (enabled === null && /Enable=true/i.test(body)) {
        enabled = true;
      } else if (enabled === null && /Enable=false/i.test(body)) {
        enabled = false;
      }
      return { ok: true, enabled, raw: props };
    } catch (err) {
      return { ok: false, enabled: null, error: err.message };
    }
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
    try {
      this._parseEventChunk(raw);
    } catch (err) {
      this.log.warn(`Event parse error: ${err.message}`);
    }
  }

  _parseEventChunk(raw) {
    const text = raw.trim();
    if (!text || text.startsWith("--") || text.startsWith("HTTP/")) {
      return;
    }

    const codeMatch = text.match(/Code=([^;]+)/i);
    const actionMatch = text.match(/action=([^;]+)/i);
    const indexMatch = text.match(/index=([^;]+)/i);
    if (!codeMatch) {
      if (this.config.debug) {
        this.log.debug(`Event chunk without Code=: ${text.slice(0, 200)}`);
      }
      return;
    }

    const code = codeMatch[1].trim();
    const action = actionMatch ? actionMatch[1].trim() : "Pulse";
    const index = indexMatch ? Number(indexMatch[1].trim()) : 0;
    let data = {};
    const dataMatch = text.match(/data=(\{[\s\S]*\})/i);
    if (dataMatch) {
      try {
        data = JSON.parse(dataMatch[1]);
      } catch {
        data = { raw: dataMatch[1] };
      }
    }

    const event = { Code: code, Action: action, Index: index, Data: data, raw: text };
    this.log.debug(`Event ${code}/${action}` + (this.config.debug ? ` raw=${text}` : ""));
    this.emit("event", event);

    // Benign noise — acknowledge so debug is not flooded
    const ignore = new Set([
      "SIPRegisterResult",
      "TimeChange",
      "NTPAdjustTime",
      "RtspSessionDisconnect",
    ]);
    if (ignore.has(code)) {
      return;
    }

    // Scrypted AmcrestEvent mappings + VTO2111D / VTO2211G field events
    let handled = true;

    // Motion / IVS / SMD — HomeKit + HKSV need MotionDetected
    const motionStart = isMotionStart(code, action);
    const motionStop = isMotionStop(code, action);
    if (motionStart) {
      this.emit("motion", true, event);
    } else if (motionStop) {
      this.emit("motion", false, event);
    } else if (code === "CallNoAnswered" && action === "Start") {
      this.emit("doorbell", event);
      this.emit("motion", true, event);
    } else if (code === "_CallNoAnswer_" && action === "Pulse") {
      this.emit("doorbell", event);
    } else if (code === "_DoTalkAction_" && (action === "Invite" || action === "Pulse")) {
      this.emit("doorbell", event);
    } else if (code === "Invite" && action === "Pulse") {
      // Same call as CallNoAnswered on many VTOs — doorbell only (dedupe in accessory)
      this.emit("doorbell", event);
    } else if (code === "BackKeyLight") {
      const state = data?.State;
      if (state === 1 || state === 8 || state === "1" || state === "8") {
        this.emit("doorbell", event);
      } else {
        handled = false;
      }
    } else if (code === "DoorCard") {
      // Card presented: data.Number = hex card id
      this.emit("card", {
        ...event,
        cardNo: String(data?.Number || data?.CardNo || "").trim(),
      });
    } else if (code === "AccessControl") {
      this.emit("accessControl", event);
      const cardNo = String(data?.CardNo || "").trim();
      const name = String(data?.Name || "");
      const status = data?.Status;
      const method = Number(data?.Method);
      const opened = name === "OpenDoor" && (status === 1 || status === "1");

      if (cardNo) {
        this.emit("card", { ...event, cardNo });
      } else if (opened && (method === 5 || method === 4)) {
        // Method 5 = exit button OpenDoor on VTO2111D / VTO2211G
        this.emit("exit", event);
      }

      if (opened) {
        this.emit("doorOpened", {
          door: this.config.doorChannel,
          source: cardNo ? "card" : method === 5 ? "exit" : "accessControl",
          cardNo,
          event,
        });
      }
    } else if (code === "AlarmLocal" && action === "Start") {
      // Exit button on tested VTOs uses AlarmLocal index=3
      const exitIndex = this.config.exitAlarmIndex;
      if (exitIndex == null || Number(exitIndex) === index) {
        this.emit("exit", event);
      } else {
        this.emit("alarmLocal", event);
      }
    } else if (code === "AlarmLocal" && action === "Stop") {
      // paired with Start — ignore
    } else {
      handled = false;
    }

    // Help users testing other VTO models: surface unknown CGI codes when debug is on
    if (!handled && this.config.debug) {
      this.log.debug(
        `Unhandled CGI event (please include in GitHub issue if ring/motion missing): ` +
          `${code}/${action} data=${JSON.stringify(data)}`
      );
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
  parseDahuaKeyValues,
  normalizeFirmware,
  isMotionStart,
  isMotionStop,
};

/** Codes that mean “someone / something moved” for HomeKit + HKSV. */
const MOTION_CODES = new Set([
  "VideoMotion",
  "VideoMotionInfo",
  "SmartMotionHuman",
  "SmartMotionVehicle",
  "CrossLineDetection",
  "CrossRegionDetection",
  "FaceDetection",
  "WanderDetection",
  "MoveDetection",
  "RioterDetection",
  "LeftDetection",
  "TakenAwayDetection",
  "VideoAbnormalDetection",
  "IntelliFrame",
]);

function isMotionStart(code, action) {
  if (!MOTION_CODES.has(code)) {
    return false;
  }
  // Start or Pulse (some firmware only pulses)
  return action === "Start" || action === "Pulse";
}

function isMotionStop(code, action) {
  if (!MOTION_CODES.has(code)) {
    return false;
  }
  return action === "Stop";
}

function parseDahuaKeyValues(body) {
  const out = {};
  for (const line of String(body).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("--")) {
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

/** HomeKit FirmwareRevision prefers x.y.z — normalize Dahua strings when possible. */
function normalizeFirmware(raw) {
  const s = String(raw || "").trim();
  if (!s) {
    return "1.0.0";
  }
  // Already looks like a.b.c...
  if (/^\d+(\.\d+){1,3}/.test(s)) {
    const parts = s.split(/[^0-9]+/).filter(Boolean).slice(0, 3);
    while (parts.length < 3) {
      parts.push("0");
    }
    return parts.join(".");
  }
  return s.slice(0, 64) || "1.0.0";
}
