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

const CHARGING_STATES = ['charging', 'discharging', 'idle'];

module.exports = class SolarEdgeBatteryDevice extends CommonDevice {

  async onPoll() {
    const sitePowerflow = await this.client.getSitePowerflow({ siteId: this.getData().siteId });
    const { storage } = sitePowerflow;

    // currentPower in kW, always positive: negative while discharging
    if (typeof storage?.currentPower === 'number') {
      let power = Math.round(storage.currentPower * 1000);
      if (storage.status === 'discharging') power *= -1;
      await this.setCapability('measure_power', power);
    }

    if (typeof storage?.chargeLevel === 'number') {
      await this.setCapability('measure_battery', storage.chargeLevel);
    }

    if (CHARGING_STATES.includes(storage?.status)) {
      await this.setCapability('battery_charging_state', storage.status);
    }

    if (storage?.isActive) {
      await this.setAvailable();
    } else {
      await this.setUnavailable();
    }

    if (this.energyDue()) {
      await this.updateSiteAlarms().catch((error) => this.error(`Error Fetching Site Alarms: ${error.message}`));
    }
  }

};
