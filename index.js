"use strict";

const { PLATFORM_NAME, PLUGIN_NAME } = require("./src/settings");
const { setHap } = require("./src/hap");

module.exports = (api) => {
  setHap(api.hap);
  const { DahuaVtoPlatform } = require("./src/platform");
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, DahuaVtoPlatform);
};
