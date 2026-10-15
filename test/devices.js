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

/*
 * Device mappings that the replays cannot reach: the EV charger in every state of a real answer
 * (test/fixtures/ev-charger-devices.json), counters that never fall, battery energies in kWh, and
 * optimizer temperatures in Fahrenheit.
 */

const fs = require('node:fs');
const path = require('node:path');
const { manifest } = require('./harness');

const ROOT = path.join(__dirname, '..');
const { responses } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ev-charger-devices.json'), 'utf8'));

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const newDevice = (driverId, data, client) => {
  const DeviceClass = require(path.join(ROOT, 'drivers', driverId, 'device.js')); // eslint-disable-line import/no-dynamic-require, global-require
  const driverManifest = manifest.drivers.find((driver) => driver.id === driverId);
  const device = new DeviceClass({ driverManifest, data: { siteId: 1, ...data }, settings: {} });
  device.client = client;
  return device;
};

// state -> [evcharger_charging_state, evcharger_charging, ev_charge_mode, ev_solar_charging]
const EV_EXPECTED = {
  charging: ['plugged_in_charging', true, 'manual', false],
  pluggedin_not_charging: ['plugged_in', false, 'manual', false],
  pluggedin_pending_schedule: ['plugged_in', false, 'auto', false],
  pluggedin_pending_solar: ['plugged_in', false, 'auto', true],
  unplugged_not_charging: ['plugged_out', false, 'manual', false],
  unplugged_not_charging_excesspv_and_schedule_disabled: ['plugged_out', false, 'manual', false],
  'unplugged_not_charging_excesspv_disabled_but_schedule_enabled_M-F1000-1200_SASU0900-2000': ['plugged_out', false, 'auto', false],
  unplugged_not_charging_excesspv_enabled_schedule_disabled: ['plugged_out', false, 'auto', true],
};

const evCharger = async () => {
  for (const [state, response] of Object.entries(responses)) {
    const charger = response.devicesByType.EV_CHARGER[0];
    const device = newDevice('evcharger', { reporterId: charger.reporterId }, { getSiteDevices: async () => response });
    // the powerflow had no connection status: it comes from the devices answer
    await device.updateSession(true); // eslint-disable-line no-await-in-loop
    const v = device.values;
    const got = [v.evcharger_charging_state, v.evcharger_charging, v.ev_charge_mode, v.ev_solar_charging];
    check(JSON.stringify(got) === JSON.stringify(EV_EXPECTED[state]), `ev ${state}: ${JSON.stringify(got)}, expected ${JSON.stringify(EV_EXPECTED[state])}`);
    check(v['meter_power.session'] === charger.sessionEnergy / 1000, `ev ${state}: session ${v['meter_power.session']} kWh for ${charger.sessionEnergy} Wh`);
    check(v.ev_session_duration === Math.round(charger.sessionDuration / 60), `ev ${state}: duration ${v.ev_session_duration} min`);
    check(v.ev_vehicle === charger.applianceData?.alias, `ev ${state}: vehicle ${v.ev_vehicle}`);
    device.problems.forEach((problem) => failures.push(`ev ${state}: ${problem}`));
  }
};

const monotonic = async () => {
  const device = newDevice('battery', {}, {});
  const readings = [10, 12, 3, 5, 5, 1];
  const results = [];
  for (const reading of readings) results.push(await device.monotonic('test', reading)); // eslint-disable-line no-await-in-loop
  // falls at 3 (by 9) and 1 (by 4) continue from the last total
  check(JSON.stringify(results) === JSON.stringify([10, 12, 12, 14, 14, 14]), `monotonic: ${JSON.stringify(results)}`);
};

const batteryKwh = async () => {
  const battery = {
    chargeEnergy: 1234.5, dischargeEnergy: 1000, remainingEnergy: 6.2, fullPackEnergy: 9.2, namePlateEnergy: 9.7, info: { serialNumber: 'B1' },
  };
  const device = newDevice('battery', {}, { getSiteBatteries: async () => ({ devicesByType: { BATTERY: [battery] } }) });
  await device.updateBatteries();
  const v = device.values;
  check(v['meter_power.charged'] === 1234.5 && v.measure_residual_energy === 6.2 && v.measure_soh === 95, `battery kWh: ${JSON.stringify(v)}`);
};

const fahrenheit = async () => {
  const optimizer = (temperature, temperatureUnit) => ({ temperature: { temperature, temperatureUnit } });
  const device = newDevice('inverter', {}, {
    getSiteEquipment: async () => ({ inverters: { details: [{ serialNumbers: ['I1'] }] } }),
    getInvertersInformation: async () => ({}),
    getSites: async () => ({ 1: { id: 1, timezone: 'UTC' } }),
    getSiteEnergyByInverter: async () => ({ inverters: [{ optimizers: [optimizer(104, 'FAHRENHEIT'), optimizer(35, 'CELSIUS')] }] }),
  });
  await device.updateInverterDetails();
  check(device.values['measure_temperature.max'] === 40, `fahrenheit: ${device.values['measure_temperature.max']} °C for 104 °F`);
};

(async () => {
  await evCharger();
  await monotonic();
  await batteryKwh();
  await fahrenheit();
  if (failures.length) {
    console.error(`FAIL - ${failures.length} problem(s):\n`);
    failures.forEach((failure) => console.error(`  ${failure}`));
    process.exitCode = 1;
  } else {
    console.log(`OK - devices: ${Object.keys(responses).length} EV charger states, monotonic counters, battery kWh, Fahrenheit`);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
