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

const ModbusDevice = require('../../lib/modbus_device');

module.exports = class SolarEdgeBatteryModbusDevice extends ModbusDevice {

  /**
   * One device per inverter combines its batteries (lib/solarEdgePointMap.js): a device of a 2nd or
   * 3rd battery (base above 0, paired before) only asks to be deleted.
   */
  async onInit() {
    if (this.base !== 0) {
      await this.setUnavailable(this.homey.__('errors.batteryMerged'));
      this.log(`${this.getName()} is a 2nd or 3rd battery, now part of the inverter's 1st battery device`);
      return;
    }
    await super.onInit();
  }

  /** Such a device was never set up: a changed address must not start it. */
  async onSettings(event) {
    if (this.base !== 0) return;
    await super.onSettings(event);
  }

  async setControl(values) {
    if (this.base !== 0) throw Error(this.homey.__('errors.batteryMerged'));
    await super.setControl(values);
  }

  async runAction(name, args) {
    if (this.base !== 0) throw Error(this.homey.__('errors.batteryMerged'));
    await super.runAction(name, args);
  }

};
