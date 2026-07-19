"use strict";

const { PLATFORM_NAME, PLUGIN_NAME } = require("./settings");
const { DahuaVtoAccessory } = require("./accessory");

/**
 * Dynamic platform — one HomeKit accessory per configured VTO.
 */
class DahuaVtoPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];
    this.controllers = [];

    if (!config) {
      this.log.warn("No config — plugin idle until configured in Homebridge UI");
      return;
    }

    api.on("didFinishLaunching", () => this.discover());
    api.on("shutdown", () => this.shutdown());
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  discover() {
    const devices = Array.isArray(this.config.cameras) ? this.config.cameras : [];
    if (!devices.length && this.config.host) {
      // Single-camera shorthand at platform root
      devices.push(this.config);
    }

    if (!devices.length) {
      this.log.warn("No cameras configured");
      return;
    }

    const keep = new Set();

    for (const deviceConfig of devices) {
      if (!deviceConfig.host) {
        this.log.error("Camera entry missing host — skipped");
        continue;
      }

      const name = deviceConfig.name || `Dahua VTO ${deviceConfig.host}`;
      const uuid = this.api.hap.uuid.generate(`homebridge-dahua-vto:${deviceConfig.host}`);
      keep.add(uuid);

      let accessory = this.accessories.find((a) => a.UUID === uuid);
      if (!accessory) {
        this.log.info(`Adding accessory: ${name}`);
        accessory = new this.api.platformAccessory(name, uuid, this.api.hap.Categories.VIDEO_DOORBELL);
        const ctrl = new DahuaVtoAccessory(this.log, deviceConfig, this.api, accessory);
        this.controllers.push(ctrl);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
      } else {
        this.log.info(`Restoring accessory: ${name}`);
        accessory.displayName = name;
        const ctrl = new DahuaVtoAccessory(this.log, deviceConfig, this.api, accessory);
        this.controllers.push(ctrl);
        this.api.updatePlatformAccessories([accessory]);
      }
    }

    const stale = this.accessories.filter((a) => !keep.has(a.UUID));
    if (stale.length) {
      this.log.info(`Removing ${stale.length} stale accessory(ies)`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.accessories = this.accessories.filter((a) => keep.has(a.UUID));
    }
  }

  shutdown() {
    for (const ctrl of this.controllers) {
      try {
        ctrl.teardown();
      } catch (err) {
        this.log.warn(`Shutdown: ${err.message}`);
      }
    }
  }
}

module.exports = {
  DahuaVtoPlatform,
};
