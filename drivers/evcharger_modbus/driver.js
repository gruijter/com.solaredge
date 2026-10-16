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

const ModbusDriver = require('../../lib/modbus_driver');

module.exports = class SolarEdgeEvChargerModbusDriver extends ModbusDriver {

  async onInit() {
    await super.onInit();
    this.homey.flow.getActionCard('set_session_energy_limit')
      .registerRunListener(({ device, kwh }) => device.setControl({ session_energy_limit: kwh }));
    this.homey.flow.getActionCard('set_charging_phases')
      .registerRunListener(({ device, phases }) => device.runAction('chargingPhases', { phases }));
  }

};
