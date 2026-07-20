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
    // If user set these in config, keep them; otherwise refresh from magicBox.cgi
    modelOverride: raw.model != null && String(raw.model).trim() !== "" && String(raw.model).trim() !== "VTO",
    firmwareOverride: raw.firmware != null && String(raw.firmware).trim() !== "" && String(raw.firmware).trim() !== "1.0.0",
    manufacturerOverride: raw.manufacturer != null && String(raw.manufacturer).trim() !== "" && String(raw.manufacturer).trim() !== "Dahua",
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
      // AlarmLocal index for exit button (VTO2111D / VTO2211G log: index=3)
      exitAlarmIndex: raw.exitAlarmIndex != null ? Number(raw.exitAlarmIndex) : 3,
    },
    sensors: {
      card: raw.cardSensor !== false,
      exit: raw.exitSensor !== false,
      pulseMs: Number(raw.sensorPulseMs || 3000),
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
    this.infoService = accessory.getService(Service.AccessoryInformation);
    this.infoService
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
    this._sensorTimers = new Map();
    this._lastDoorbellAt = 0;
    this._lastCardAt = 0;
    this._lastExitAt = 0;

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
    this._setupSensors();
    this._wireEvents();

    // Defer CGI until after HAP has published
    setTimeout(() => {
      this._refreshDeviceInfo()
        .catch((err) => this.log.warn(`Device info: ${err.message}`))
        .then(() => this._checkMotionDetect())
        .catch((err) => this.log.debug(`MotionDetect check: ${err.message}`))
        .finally(() => {
          try {
            this.dahua.startEventStream();
          } catch (err) {
            this.log.error(`Event stream start failed: ${err.message}`);
          }
        });
    }, 1500);

    this.log.info(
      `Ready @ ${this.config.dahua.host} ` +
        `(model=${this.config.model}, twoWay=${this.config.twoWayAudio}, ` +
        `hksv=${this.config.hksv.enabled}, card=${this.config.sensors.card}, ` +
        `exit=${this.config.sensors.exit}, debug=${this.config.debug})`
    );
  }

  async _refreshDeviceInfo() {
    const info = await this.dahua.getDeviceInfo();
    const { Characteristic } = this.hap;
    const svc = this.infoService;
    if (!svc || !info) {
      return;
    }

    if (!this.config.manufacturerOverride && info.manufacturer) {
      svc.setCharacteristic(Characteristic.Manufacturer, info.manufacturer);
      this.config.manufacturer = info.manufacturer;
    }
    if (!this.config.modelOverride && info.model) {
      svc.setCharacteristic(Characteristic.Model, info.model);
      this.config.model = info.model;
    }
    if (info.serialNumber && info.serialNumber.length >= 2) {
      svc.setCharacteristic(Characteristic.SerialNumber, info.serialNumber);
    }
    if (info.hardwareRevision) {
      try {
        svc.setCharacteristic(Characteristic.HardwareRevision, info.hardwareRevision);
      } catch {
        /* older HAP without HardwareRevision */
      }
    }
    if (!this.config.firmwareOverride && info.firmware) {
      svc.setCharacteristic(Characteristic.FirmwareRevision, info.firmware);
      this.config.firmware = info.firmware;
    }

    this.log.info(
      `Device identity from VTO: model=${info.model || "?"} ` +
        `serial=${info.serialNumber || "?"} firmware=${info.firmware || "?"}`
    );
  }

  async _checkMotionDetect() {
    const status = await this.dahua.getMotionDetectStatus();
    if (!status.ok) {
      this.log.debug(`MotionDetect config unavailable: ${status.error || status.raw || "?"}`);
      return;
    }
    if (status.enabled === false) {
      this.log.warn(
        "VTO MotionDetect is DISABLED — HomeKit will not see walk-by motion / HKSV clips. " +
          "Enable Motion Detection (or SMD/IVS) in the VTO web UI, then walk in front of the camera " +
          "with debug=true and look for VideoMotion / SmartMotionHuman events."
      );
    } else if (status.enabled === true) {
      this.log.info("VTO MotionDetect is enabled");
    } else {
      this.log.info(
        "Could not parse MotionDetect.Enable — if walk-by motion is missing, enable it in VTO web UI"
      );
    }
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

  _setupSensors() {
    const { Service, Characteristic } = this.hap;
    const doorbellService = this.accessory.getService(Service.Doorbell);

    if (this.config.sensors.card) {
      this.cardService =
        this.accessory.getServiceById(Service.ContactSensor, "card") ||
        this.accessory.getService("Card Access") ||
        this.accessory.addService(Service.ContactSensor, "Card Access", "card");
      this.cardService.updateCharacteristic(
        Characteristic.ContactSensorState,
        Characteristic.ContactSensorState.CONTACT_DETECTED
      );
      try {
        doorbellService?.addLinkedService(this.cardService);
      } catch {
        /* ignore */
      }
    }

    if (this.config.sensors.exit) {
      this.exitService =
        this.accessory.getServiceById(Service.ContactSensor, "exit") ||
        this.accessory.getService("Exit Button") ||
        this.accessory.addService(Service.ContactSensor, "Exit Button", "exit");
      this.exitService.updateCharacteristic(
        Characteristic.ContactSensorState,
        Characteristic.ContactSensorState.CONTACT_DETECTED
      );
      try {
        doorbellService?.addLinkedService(this.exitService);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Pulse a contact sensor: CONTACT_NOT_DETECTED = "triggered" for automations,
   * then back to CONTACT_DETECTED (idle closed).
   */
  _pulseContact(service, key, reason = "") {
    if (!service) {
      return;
    }
    const { Characteristic } = this.hap;
    service.updateCharacteristic(
      Characteristic.ContactSensorState,
      Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
    );
    this.log.info(`Sensor ${key} triggered${reason ? ` (${reason})` : ""}`);

    const prev = this._sensorTimers.get(key);
    if (prev) {
      clearTimeout(prev);
    }
    const t = setTimeout(() => {
      service.updateCharacteristic(
        Characteristic.ContactSensorState,
        Characteristic.ContactSensorState.CONTACT_DETECTED
      );
      this._sensorTimers.delete(key);
    }, this.config.sensors.pulseMs);
    this._sensorTimers.set(key, t);
  }

  _markDoorUnlocked(source = "") {
    const { Characteristic } = this.hap;
    if (!this.lockService) {
      return;
    }
    this.targetState = Characteristic.LockTargetState.UNSECURED;
    this.currentState = Characteristic.LockCurrentState.UNSECURED;
    this.lockService.updateCharacteristic(Characteristic.LockTargetState, this.targetState);
    this.lockService.updateCharacteristic(Characteristic.LockCurrentState, this.currentState);
    this.log.info(`Door unlocked (${source || "event"})`);

    if (this.lockTimeout) {
      clearTimeout(this.lockTimeout);
    }
    this.lockTimeout = setTimeout(() => {
      this.targetState = Characteristic.LockTargetState.SECURED;
      this.currentState = Characteristic.LockCurrentState.SECURED;
      this.lockService.updateCharacteristic(Characteristic.LockTargetState, this.targetState);
      this.lockService.updateCharacteristic(Characteristic.LockCurrentState, this.currentState);
      this.unlocking = false;
      this.log.info("Door re-secured");
    }, this.config.dahua.unlockSeconds * 1000);
  }

  setMotion(active, reason = "") {
    const { Service, Characteristic } = this.hap;
    this.motionActive = Boolean(active);

    // Prefer the MotionSensor created by DoorbellController (required for HKSV)
    let motionService =
      this.accessory.getService(Service.MotionSensor) ||
      this.accessory.services?.find((s) => s.UUID === Service.MotionSensor.UUID);

    if (!motionService) {
      this.log.warn(`Motion service missing — cannot notify HomeKit (${reason || "motion"})`);
      return;
    }

    const char = motionService.getCharacteristic(Characteristic.MotionDetected);
    // updateValue notifies HomeKit / triggers HKSV when going true
    if (typeof char.updateValue === "function") {
      char.updateValue(this.motionActive);
    } else {
      motionService.updateCharacteristic(Characteristic.MotionDetected, this.motionActive);
    }

    this.log.info(`Motion=${this.motionActive}${reason ? ` (${reason})` : ""}`);
    if (this.motionTimer) {
      clearTimeout(this.motionTimer);
      this.motionTimer = null;
    }
    if (this.motionActive) {
      this.motionTimer = setTimeout(() => {
        this.motionActive = false;
        if (typeof char.updateValue === "function") {
          char.updateValue(false);
        } else {
          motionService.updateCharacteristic(Characteristic.MotionDetected, false);
        }
        this.log.info("Motion auto-cleared");
      }, this.config.hksv.motionTimeoutMs);
    }
  }

  _wireEvents() {
    this.dahua.on("motion", (active, event) => {
      this.setMotion(active, event?.Code || "motion");
    });

    this.dahua.on("doorbell", (event) => {
      const now = Date.now();
      // CallNoAnswered + Invite often arrive together — one Home notification
      if (now - this._lastDoorbellAt < 2500) {
        this.log.debug(`Doorbell deduped (${event?.Code || "unknown"})`);
        return;
      }
      this._lastDoorbellAt = now;
      this.log.info(`Doorbell ring (${event?.Code || "unknown"})`);
      this.setMotion(true, "doorbell");
      try {
        this.controller.ringDoorbell();
      } catch (err) {
        this.log.warn(`ringDoorbell failed: ${err.message}`);
      }
    });

    this.dahua.on("card", (event) => {
      const now = Date.now();
      if (now - this._lastCardAt < 2000) {
        return;
      }
      this._lastCardAt = now;
      const cardNo = event?.cardNo || event?.Data?.Number || event?.Data?.CardNo || "";
      this.log.info(`Card access${cardNo ? ` (${cardNo})` : ""}`);
      this._pulseContact(this.cardService, "card", cardNo || event?.Code);
      this.setMotion(true, "card");
    });

    this.dahua.on("exit", (event) => {
      const now = Date.now();
      if (now - this._lastExitAt < 2000) {
        return;
      }
      this._lastExitAt = now;
      this.log.info(`Exit button (${event?.Code || "unknown"} index=${event?.Index ?? "?"})`);
      this._pulseContact(this.exitService, "exit", event?.Code);
      this.setMotion(true, "exit");
    });

    this.dahua.on("doorOpened", (info) => {
      // Physical open (card / exit / accessControl) — mirror lock in Home
      if (!this.unlocking) {
        this._markDoorUnlocked(info?.source || "accessControl");
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
    for (const t of this._sensorTimers.values()) {
      clearTimeout(t);
    }
    this._sensorTimers.clear();
  }
}

module.exports = {
  DahuaVtoAccessory,
  normalizeDeviceConfig,
};
