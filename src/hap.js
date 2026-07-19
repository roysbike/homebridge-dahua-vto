"use strict";

let hapRef = null;

function setHap(hap) {
  hapRef = hap;
}

function getHap() {
  if (!hapRef) {
    throw new Error("HAP not initialized — plugin must be loaded by Homebridge");
  }
  return hapRef;
}

module.exports = {
  setHap,
  getHap,
};
