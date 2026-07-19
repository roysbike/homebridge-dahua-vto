"use strict";

/**
 * Homebridge logger wrapper.
 * When debug=true, debug lines go to info so users see them without Homebridge -D.
 */
function createLogger(log, debug = false, prefix = "") {
  const p = prefix ? `[${prefix}] ` : "";

  const write = (level, args) => {
    if (!args.length) {
      return;
    }
    const [first, ...rest] = args;
    if (typeof first === "string") {
      log[level](p + first, ...rest);
    } else if (first instanceof Error) {
      log[level](p + (first.stack || first.message), ...rest);
    } else {
      try {
        log[level](p + JSON.stringify(first), ...rest);
      } catch {
        log[level](p + String(first), ...rest);
      }
    }
  };

  return {
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
    debug: (...args) => {
      if (debug) {
        const [first, ...rest] = args;
        if (typeof first === "string") {
          log.info(`${p}[DEBUG] ${first}`, ...rest);
        } else {
          write("info", [`[DEBUG]`, first, ...rest]);
        }
      } else {
        write("debug", args);
      }
    },
  };
}

module.exports = {
  createLogger,
};
