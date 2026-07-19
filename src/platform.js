"use strict";

const { PLATFORM_NAME, PLUGIN_NAME } = require("./settings");
const { DahuaVtoAccessory } = require("./accessory");
const { createLogger } = require("./util/logger");

/**
 * Stable id for UUID — must NOT change when host IP changes
 * (host-based UUIDs would recreate the accessory after an IP change).
 */
function deviceId(cfg) {
  return String(cfg.accessoryId || cfg.name || cfg.host || "default")
    .trim()
    .toLowerCase();
}

/**
 * Dynamic platform — one HomeKit accessory per configured VTO.
 * Idle until configured (Verified By Homebridge requirement).
 */
class DahuaVtoPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];
    this.controllers = [];
    this.debug = Boolean(this.config.debug);
    this.logger = createLogger(log, this.debug);

    // Not configured → do not start (install-only / empty platform).
    if (!config) {
      this.logger.warn("No config — plugin idle until configured in Homebridge UI");
      return;
    }

    this.logger.info(
      `homebridge-dahua-vto ${require("../package.json").version} loading` +
        (this.debug ? " (debug on)" : "")
    );

    if (this.debug) {
      this.logger.info(
        "Debug logging enabled. When testing other VTO models, open a GitHub issue with logs: " +
          "https://github.com/roysbike/homebridge-dahua-vto/issues"
      );
    }

    api.on("didFinishLaunching", () => {
      try {
        this.discover();
      } catch (err) {
        this.logger.error(`discover failed: ${err.stack || err.message}`);
      }
    });
    api.on("shutdown", () => {
      try {
        this.shutdown();
      } catch (err) {
        this.logger.warn(`Shutdown: ${err.message}`);
      }
    });
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  discover() {
    const devices = Array.isArray(this.config.cameras) ? [...this.config.cameras] : [];
    if (!devices.length && this.config.host) {
      devices.push(this.config);
    }

    if (!devices.length) {
      this.logger.warn("No cameras configured — plugin idle");
      return;
    }

    const keep = new Set();

    for (const deviceConfig of devices) {
      if (!deviceConfig || !deviceConfig.host) {
        this.logger.error("Camera entry missing host — skipped");
        continue;
      }
      if (deviceConfig.password == null || deviceConfig.password === "") {
        this.logger.warn(
          `Camera ${deviceConfig.host}: password empty — CGI auth will likely fail`
        );
      }

      const name = deviceConfig.name || `Dahua VTO ${deviceConfig.host}`;
      const id = deviceId(deviceConfig);
      const uuid = this.api.hap.uuid.generate(`homebridge-dahua-vto:${id}`);
      keep.add(uuid);

      const merged = {
        ...deviceConfig,
        debug:
          deviceConfig.debug === true ||
          (deviceConfig.debug !== false && this.debug),
      };

      // Prefer stable UUID; fall back to same displayName / context (migration from host-based UUID)
      let accessory =
        this.accessories.find((a) => a.UUID === uuid) ||
        this.accessories.find((a) => a.context?.dahuaDeviceId === id) ||
        this.accessories.find((a) => a.displayName === name);

      if (!accessory) {
        this.logger.info(`Adding accessory: ${name} (id=${id})`);
        accessory = new this.api.platformAccessory(
          name,
          uuid,
          this.api.hap.Categories.VIDEO_DOORBELL
        );
        accessory.context.dahuaDeviceId = id;
        try {
          const ctrl = new DahuaVtoAccessory(this.log, merged, this.api, accessory);
          this.controllers.push(ctrl);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.accessories.push(accessory);
          keep.add(accessory.UUID);
        } catch (err) {
          this.logger.error(`Failed to add ${name}: ${err.stack || err.message}`);
        }
      } else {
        this.logger.info(`Restoring accessory: ${name} (id=${id})`);
        accessory.displayName = name;
        accessory.context.dahuaDeviceId = id;
        keep.add(accessory.UUID);
        try {
          const ctrl = new DahuaVtoAccessory(this.log, merged, this.api, accessory);
          this.controllers.push(ctrl);
        } catch (err) {
          this.logger.error(`Failed to restore ${name}: ${err.stack || err.message}`);
        }
      }
    }

    // Do not auto-unregister stale accessories at startup (safer for cached restores).
    const stale = this.accessories.filter((a) => !keep.has(a.UUID));
    if (stale.length) {
      this.logger.warn(
        `${stale.length} cached accessory(ies) no longer in config. ` +
          `Remove them manually in Homebridge UI (Settings → Remove Single Cached Accessory) ` +
          `to avoid duplicates.`
      );
    }
  }

  shutdown() {
    for (const ctrl of this.controllers) {
      try {
        ctrl.teardown();
      } catch (err) {
        this.logger.warn(`Shutdown: ${err.message}`);
      }
    }
  }
}

module.exports = {
  DahuaVtoPlatform,
  deviceId,
};
