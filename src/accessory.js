"use strict";

const { DahuaClient } = require("./dahua/client");
const { VtoCameraDelegate, buildDoorbellController } = require("./homekit/camera");
const { createLogger } = require("./util/logger");

function normalizeDeviceConfig(raw) {
  const host = raw.host;
  const username = raw.username || "admin";
  const password = raw.password || "";
  const ssl = Boolean(raw.ssl);
  const proto = ssl ? "https" : "http";
  const doorChannel = Number(raw.doorChannel || raw.channel || 1) || 1;
  const unlockSeconds = Number(raw.unlockSeconds || 5) || 5;
  const ffmpegPath = raw.ffmpegPath || raw.videoProcessor || "ffmpeg";
  const twoWayAudio = raw.twoWayAudio !== false;
  // HKSV off by default — enable explicitly once live view/talkback are stable
  const hksv = raw.hksv === true;
  const debug = Boolean(raw.debug);

  const rtspUrl =
    raw.rtspUrl ||
    `rtsp://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:554/cam/realmonitor?channel=1&subtype=${raw.rtspSubtype ?? 0}`;

  return {
    name: raw.name || `Dahua VTO ${host}`,
    manufacturer: raw.manufacturer || "Dahua",
    model: raw.model || "VTO",
    firmware: raw.firmware || "1.0.0",
    ffmpegPath,
    rtspUrl,
    twoWayAudio,
    debug,
    dahua: {
      host,
      username,
      password,
      ssl,
      baseUrl: `${proto}://${host}/cgi-bin/`,
      doorChannel,
      unlockSeconds,
      eventCodes: raw.eventCodes || "All",
      debug,
    },
    hksv: {
      enabled: hksv,
      prebufferMs: Number(raw.hksvPrebufferMs || 4000),
      fragmentMs: Number(raw.hksvFragmentMs || 4000),
      motionTimeoutMs: Number(raw.motionTimeoutMs || 10000),
    },
  };
}

/**
 * One VIDEO_DOORBELL accessory: camera + lock + motion + two-way (Amcrest talkback).
 */
class DahuaVtoAccessory {
  constructor(log, deviceConfig, api, accessory) {
    this.api = api;
    this.accessory = accessory;
    this.config = normalizeDeviceConfig(deviceConfig);
    this.hap = api.hap;
    this.log = createLogger(log, this.config.debug, this.config.name);

    const { Service, Characteristic, Categories } = this.hap;

    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, this.config.manufacturer)
      .setCharacteristic(Characteristic.Model, this.config.model)
      .setCharacteristic(Characteristic.SerialNumber, this.config.dahua.host)
      .setCharacteristic(Characteristic.FirmwareRevision, this.config.firmware);

    // Prefer doorbell category
    accessory.category = Categories.VIDEO_DOORBELL;

    this.motionActive = false;
    this.motionTimer = null;
    this.lockTimeout = null;
    this.unlocking = false;
    this.targetState = Characteristic.LockTargetState.SECURED;
    this.currentState = Characteristic.LockCurrentState.SECURED;

    this.dahua = new DahuaClient(this.config.dahua, this.log);
    this.delegate = new VtoCameraDelegate({
      config: this.config,
      log: this.log,
      dahua: this.dahua,
      getMotionActive: () => this.motionActive,
    });

    this.controller = buildDoorbellController(this.delegate, this.config);
    this.delegate.controller = this.controller;

    // Always attach a fresh controller for this process.
    try {
      accessory.configureController(this.controller);
    } catch (err) {
      this.log.warn(`configureController: ${err.message} — replacing existing`);
      try {
        for (const c of [...(accessory.controllers || [])]) {
          try {
            accessory.removeController(c);
          } catch {
            /* ignore */
          }
        }
        accessory.configureController(this.controller);
      } catch (err2) {
        this.log.error(`configureController failed: ${err2.message}`);
      }
    }

    this._setupLock();
    this._wireEvents();

    // Defer CGI until after HAP has published (avoids racing child-bridge bring-up)
    setTimeout(() => {
      try {
        this.dahua.startEventStream();
      } catch (err) {
        this.log.error(`Event stream start failed: ${err.message}`);
      }
    }, 1500);

    this.log.info(
      `Ready @ ${this.config.dahua.host} ` +
        `(model=${this.config.model}, twoWay=${this.config.twoWayAudio}, ` +
        `hksv=${this.config.hksv.enabled}, debug=${this.config.debug})`
    );
  }

  _setupLock() {
    const { Service, Characteristic } = this.hap;
    let lockService = this.accessory.getService(Service.LockMechanism);
    if (!lockService) {
      lockService = this.accessory.addService(Service.LockMechanism, "Door Lock");
    }
    this.lockService = lockService;

    const doorbellService = this.accessory.getService(Service.Doorbell);
    if (doorbellService) {
      try {
        doorbellService.addLinkedService(lockService);
      } catch {
        /* already linked */
      }
    }

    const pushLockState = (target, current) => {
      setTimeout(() => {
        lockService.updateCharacteristic(Characteristic.LockTargetState, target);
        lockService.updateCharacteristic(Characteristic.LockCurrentState, current);
      }, 150);
    };

    lockService
      .getCharacteristic(Characteristic.LockCurrentState)
      .onGet(() => this.currentState);

    lockService
      .getCharacteristic(Characteristic.LockTargetState)
      .onGet(() => this.targetState)
      .onSet(async (value) => {
        this.targetState = value;
        if (value !== Characteristic.LockTargetState.UNSECURED) {
          return;
        }
        if (this.unlocking) {
          this.log.info("Lock SET ignored (unlock in progress)");
          return;
        }

        this.unlocking = true;
        try {
          await this.dahua.openDoor(this.config.dahua.doorChannel);
          this.currentState = Characteristic.LockCurrentState.UNSECURED;
          pushLockState(Characteristic.LockTargetState.UNSECURED, this.currentState);

          if (this.lockTimeout) {
            clearTimeout(this.lockTimeout);
          }
          this.lockTimeout = setTimeout(() => {
            this.targetState = Characteristic.LockTargetState.SECURED;
            this.currentState = Characteristic.LockCurrentState.SECURED;
            pushLockState(this.targetState, this.currentState);
            this.unlocking = false;
            this.log.info("Door re-secured");
          }, this.config.dahua.unlockSeconds * 1000);
        } catch (err) {
          this.unlocking = false;
          this.log.error(`Unlock failed: ${err.message}`);
          this.targetState = Characteristic.LockTargetState.SECURED;
          this.currentState = Characteristic.LockCurrentState.SECURED;
          pushLockState(this.targetState, this.currentState);
        }
      });
  }

  setMotion(active, reason = "") {
    const { Service, Characteristic } = this.hap;
    this.motionActive = Boolean(active);
    const motionService = this.accessory.getService(Service.MotionSensor);
    motionService?.updateCharacteristic(Characteristic.MotionDetected, this.motionActive);
    this.log.info(`Motion=${this.motionActive}${reason ? ` (${reason})` : ""}`);
    if (this.motionTimer) {
      clearTimeout(this.motionTimer);
      this.motionTimer = null;
    }
    if (this.motionActive) {
      this.motionTimer = setTimeout(() => {
        this.motionActive = false;
        motionService?.updateCharacteristic(Characteristic.MotionDetected, false);
        this.log.info("Motion auto-cleared");
      }, this.config.hksv.motionTimeoutMs);
    }
  }

  _wireEvents() {
    this.dahua.on("motion", (active, event) => {
      this.setMotion(active, event?.Code || "motion");
    });

    this.dahua.on("doorbell", (event) => {
      this.log.info(`Doorbell ring (${event?.Code || "unknown"})`);
      this.setMotion(true, "doorbell");
      try {
        this.controller.ringDoorbell();
      } catch (err) {
        this.log.warn(`ringDoorbell failed: ${err.message}`);
      }
    });
  }

  teardown() {
    try {
      this.dahua.stop();
    } catch {
      /* ignore */
    }
    if (this.motionTimer) {
      clearTimeout(this.motionTimer);
    }
    if (this.lockTimeout) {
      clearTimeout(this.lockTimeout);
    }
  }
}

module.exports = {
  DahuaVtoAccessory,
  normalizeDeviceConfig,
};
