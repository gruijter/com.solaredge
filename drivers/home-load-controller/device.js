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

const CAPABILITY = 'solaredge-home-load-controller-state';

// capability value -> activationState
const ACTIVATION_STATES = {
  on: { level: 100, mode: 'MANUAL' },
  off: { level: 0, mode: 'MANUAL' },
  auto: { mode: 'AUTO', level: null, duration: null },
};

module.exports = class SolarEdgeHomeLoadControllerDevice extends CommonDevice {

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

    const { devices } = await this.client.getSiteDevices({ siteId });

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
    }

    if (device.deviceStatus === 'ACTIVE') {
      await this.setAvailable();
    } else {
      await this.setUnavailable();
    }
  }

};
