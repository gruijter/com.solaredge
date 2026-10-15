/*
Copyright 2026, Robin de Gruijter (rmdegruijter@gmail.com)

This file is part of com.solaredge.

com.solaredge is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.solaredge is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.solaredge.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const CommonDevice = require('../../lib/common_device');
const siteDevices = require('../../lib/siteDevices');

const CAPABILITY = 'solaredge-home-load-controller-state';

// added once the device reports a power or a rated power
const OPTIONAL_CAPABILITIES = ['measure_power'];
const CAPABILITY_ORDER = [CAPABILITY, ...OPTIONAL_CAPABILITIES];

// capability value -> activationState
const ACTIVATION_STATES = {
  on: { level: 100, mode: 'MANUAL' },
  off: { level: 0, mode: 'MANUAL' },
  auto: { mode: 'AUTO', level: null, duration: null },
};

module.exports = class SolarEdgeHomeLoadControllerDevice extends CommonDevice {

  capabilityOrder() {
    return CAPABILITY_ORDER;
  }

  optionalCapabilities() {
    return OPTIONAL_CAPABILITIES;
  }

  async onInit() {
    await super.onInit();

    this.registerCapabilityListener(CAPABILITY, async (value) => {
      await this.onCapabilityState(value);
    });
  }

  async onCapabilityState(value) {
    const { siteId, reporterId } = this.getData();

    await this.client.setSiteDeviceApplianceActivationState({
      siteId,
      reporterId,
      state: { ...ACTIVATION_STATES[value] },
    });
  }

  async onPoll() {
    const { siteId, reporterId } = this.getData();

    const devices = siteDevices(await this.client.getSiteDevices({ siteId }));

    const device = devices.find((item) => item.reporterId === reporterId);
    if (!device) {
      throw Object.assign(new Error('Device Not Found'), { code: 'DEVICE_NOT_FOUND' });
    }

    if (device.activationMode === 'AUTO') {
      await this.setCapability(CAPABILITY, 'auto');
    } else if (device.activationMode === 'MANUAL') {
      // other levels leave the value as it is
      if (device.status.level === 0) await this.setCapability(CAPABILITY, 'off');
      if (device.status.level === 100) await this.setCapability(CAPABILITY, 'on');
      if (![0, 100].includes(device.status.level)) this.logOnce(`level ${device.status.level}`, 'manual level', device.status.level);
    }

    if (!['AUTO', 'MANUAL'].includes(device.activationMode)) this.logOnce(`mode ${device.activationMode}`, 'unknown activationMode', device.activationMode);

    await this.updatePower(device);

    if (device.deviceStatus === 'ACTIVE') {
      await this.setAvailable();
    } else {
      await this.setUnavailable();
    }
  }

  /**
   * W: the device's meter (status.activePowerMeter) when it has one, else config.ratedPower ×
   * status.level / 100, which is what the SolarEdge app shows for relays without a meter
   * (karuzo17/solaredge-api-home-assistant; fields seen in a real answer, solaredge-evcharger-ha#6).
   * An estimate: a switched-on appliance can draw less than its rated power.
   */
  async updatePower(device) {
    const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
    const measured = number(device.status?.activePowerMeter);
    const rated = number(device.config?.ratedPower);
    const level = number(device.status?.level);
    let power = null;
    if (measured !== null) power = Math.round(measured);
    else if (rated !== null && level !== null) power = Math.round((rated * level) / 100);
    this.logOnce(`power ${measured === null ? 'estimated' : 'measured'}`, `power ${measured === null ? 'estimated from' : 'measured,'} rated ${rated} W`);

    await this.recordSeenCaps({ measure_power: power });
    if (power !== null) await this.setCapability('measure_power', power);
  }

};
