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
 * CommonDevice.migrate() on devices as v1.8.1 left them, and on freshly paired ones: the resulting
 * capability list and energy object, values carried over, and what was removed on the way.
 */

const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { manifest } = require('./harness');

const ROOT = path.join(__dirname, '..');

// v1.8.1 devices; the meter added measure_power.grid and .solar on its first poll
const CASES = [
  {
    name: 'meter from 1.8.1',
    driverId: 'meter',
    capabilities: ['measure_power', 'meter_power.imported', 'meter_power.exported', 'measure_power.grid', 'measure_power.solar'],
    values: {
      'meter_power.imported': 1234, 'meter_power.exported': 567, 'measure_power.grid': -800, 'measure_power.solar': 2400,
    },
    expected: ['measure_power', 'measure_power.load', 'measure_power.solar', 'measure_power.grid', 'meter_power.imported', 'meter_power.exported', 'alarm_connectivity'],
    keep: [],
  },
  {
    name: 'evcharger from 1.8.1',
    driverId: 'evcharger',
    capabilities: ['measure_power', 'meter_power.charged', 'meter_power.discharged', 'evcharger_charging', 'evcharger_charging_state'],
    energy: {
      evCharger: true, meterPowerImportedCapability: 'meter_power.charged', meterPowerExportedCapability: 'meter_power.discharged',
    },
    values: { 'meter_power.charged': 321, evcharger_charging: true, evcharger_charging_state: 'plugged_in_charging' },
    expected: ['measure_power', 'meter_power.charged', 'evcharger_charging', 'evcharger_charging_state'],
    keep: ['meter_power.charged', 'evcharger_charging', 'evcharger_charging_state'],
  },
  {
    name: 'battery from 1.8.1',
    driverId: 'battery',
    capabilities: ['measure_battery', 'measure_power', 'battery_charging_state'],
    energy: { homeBattery: true, batteries: ['INTERNAL'] },
    values: { measure_battery: 55 },
    expected: ['measure_battery', 'measure_power', 'battery_charging_state', 'meter_power.charged', 'meter_power.discharged', 'alarm_connectivity'],
    keep: ['measure_battery', 'measure_power', 'battery_charging_state'],
  },
  {
    name: 'inverter from 1.8.1',
    driverId: 'inverter',
    capabilities: ['measure_power', 'meter_power', 'meter_power.day', 'meter_power.month', 'meter_power.year'],
    values: { meter_power: 29337.6, 'meter_power.day': 6.2 },
    expected: ['measure_power', 'meter_power', 'meter_power.day', 'meter_power.month', 'meter_power.year', 'alarm_problem', 'alarm_connectivity'],
    keep: ['measure_power', 'meter_power', 'meter_power.day', 'meter_power.month', 'meter_power.year'],
  },
  {
    name: 'inverter that reported phase 1 and temperature',
    driverId: 'inverter',
    capabilities: ['measure_power', 'meter_power', 'meter_power.day', 'meter_power.month', 'meter_power.year', 'alarm_problem', 'alarm_connectivity'],
    store: { seenCaps: { 'measure_power.1': true, 'measure_temperature.max': true } },
    values: { alarm_problem: false },
    expected: ['measure_power', 'meter_power', 'meter_power.day', 'meter_power.month', 'meter_power.year',
      'measure_temperature.max', 'measure_power.1', 'alarm_problem', 'alarm_connectivity'],
    keep: ['measure_power', 'meter_power', 'meter_power.day', 'meter_power.month', 'meter_power.year'],
  },
  ...manifest.drivers.map((driver) => ({
    name: `${driver.id} freshly paired`,
    driverId: driver.id,
    capabilities: driver.capabilities,
    values: {},
    expected: driver.capabilities,
    keep: driver.capabilities,
  })),
];

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const runCase = async ({
  name, driverId, capabilities, energy, store = {}, values, expected, keep,
}) => {
  const driverManifest = manifest.drivers.find((driver) => driver.id === driverId);
  const DeviceClass = require(path.join(ROOT, 'drivers', driverId, 'device.js')); // eslint-disable-line import/no-dynamic-require, global-require
  const device = new DeviceClass({
    driverManifest, data: {}, settings: {}, capabilities, energy,
  });
  Object.assign(device.values, values);
  Object.assign(device.store, store);
  const removed = [];
  const removeCapability = device.removeCapability.bind(device);
  device.removeCapability = async (id) => {
    removed.push(id);
    await removeCapability(id);
  };

  await device.migrate();

  const result = device.getCapabilities();
  check(isDeepStrictEqual(result, expected), `${name}: capabilities ${JSON.stringify(result)}, expected ${JSON.stringify(expected)}`);
  check(isDeepStrictEqual(device.getEnergy(), driverManifest.energy ?? null), `${name}: energy ${JSON.stringify(device.getEnergy())}`);
  const touched = removed.filter((id) => keep.includes(id));
  check(!touched.length, `${name}: removed and re-added ${touched.join(', ')}`);
  for (const [id, value] of Object.entries(values)) {
    if (result.includes(id)) check(device.values[id] === value, `${name}: ${id} is ${device.values[id]}, was ${value}`);
  }
  check(device.available, `${name}: left unavailable`);
  const untitled = device.optionalCapabilities()
    .filter((id) => !driverManifest.capabilitiesOptions?.[id]?.title && !manifest.capabilities?.[id]?.title);
  check(!untitled.length, `${name}: optional capabilities without a title: ${untitled.join(', ')}`);
  device.problems.forEach((problem) => failures.push(`${name}: ${problem}`));
  console.log(`  ${name}: removed ${JSON.stringify(removed)} -> ${JSON.stringify(result)}`);
};

(async () => {
  for (const testCase of CASES) await runCase(testCase); // eslint-disable-line no-await-in-loop
  if (failures.length) {
    console.error(`FAIL - ${failures.length} problem(s):\n`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`OK - ${CASES.length} migrations`);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
