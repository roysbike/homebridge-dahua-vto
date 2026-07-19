"use strict";

const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { URL } = require("url");

/**
 * Minimal HTTP Digest client (Dahua uses Digest Auth on CGI endpoints).
 * Matches Scrypted Amcrest authHttpFetch behavior for VTO CGI.
 */
async function digestRequest(
  urlString,
  { method = "GET", username, password, timeoutMs = 15000, responseType = "text" } = {}
) {
  const url = new URL(urlString);
  const transport = url.protocol === "https:" ? https : http;

  const first = await rawRequest(transport, url, { method, headers: {} }, timeoutMs, responseType);
  if (first.statusCode !== 401 || !first.headers["www-authenticate"]) {
    return first;
  }

  const authorization = buildDigestAuthorization({
    wwwAuthenticate: first.headers["www-authenticate"],
    method,
    urlString,
    username,
    password,
  });

  return rawRequest(
    transport,
    url,
    {
      method,
      headers: {
        Authorization: authorization,
      },
    },
    timeoutMs,
    responseType
  );
}

/**
 * Fetch a Digest challenge via GET (never POST audio.cgi — VTO hangs waiting for body).
 * Returns Authorization header value for the *target* method/URI.
 */
async function getDigestAuthorization({
  challengeUrl,
  method,
  targetUrl,
  username,
  password,
  timeoutMs = 5000,
}) {
  const url = new URL(challengeUrl);
  const transport = url.protocol === "https:" ? https : http;
  const res = await rawRequest(transport, url, { method: "GET", headers: {} }, timeoutMs, "text");
  const www = res.headers["www-authenticate"];
  if (res.statusCode !== 401 || !www) {
    return "";
  }
  return buildDigestAuthorization({
    wwwAuthenticate: www,
    method,
    urlString: targetUrl,
    username,
    password,
  });
}

function buildDigestAuthorization({ wwwAuthenticate, method, urlString, username, password }) {
  const url = new URL(urlString);
  const challenge = parseWwwAuthenticate(wwwAuthenticate);
  const realm = challenge.realm || "";
  const nonce = challenge.nonce || "";
  const qop = (challenge.qop || "").split(",")[0].trim();
  const opaque = challenge.opaque;
  const algorithm = (challenge.algorithm || "MD5").toUpperCase();

  const nc = "00000001";
  const cnonce = crypto.randomBytes(8).toString("hex");
  const uri = `${url.pathname}${url.search}`;
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  const authParts = [
    `Digest username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `algorithm=${algorithm}`,
    `response="${response}"`,
  ];
  if (qop) {
    authParts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  }
  if (opaque) {
    authParts.push(`opaque="${opaque}"`);
  }
  return authParts.join(", ");
}

function md5(value) {
  return crypto.createHash("md5").update(value).digest("hex");
}

function parseWwwAuthenticate(header) {
  const result = {};
  const body = String(header).replace(/^Digest\s+/i, "");
  for (const part of body.match(/(?:[a-zA-Z0-9_]+)=(?:"[^"]*"|[^,]*)/g) || []) {
    const idx = part.indexOf("=");
    const key = part.slice(0, idx);
    let val = part.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

function rawRequest(transport, url, options, timeoutMs, responseType = "text") {
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: options.method || "GET",
        headers: options.headers || {},
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: responseType === "buffer" ? buf : buf.toString("utf8"),
            raw: res,
          });
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("HTTP request timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

module.exports = {
  digestRequest,
  getDigestAuthorization,
  buildDigestAuthorization,
};
