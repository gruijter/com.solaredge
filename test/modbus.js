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
 * The Modbus drivers against real register dumps (test/fixtures/modbus), served by a fake Modbus
 * TCP server: pairing finds the units, then each device detects, polls and reads its identity once
 * over the real ModbusClient.
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { manifest, loadDriver } = require('./harness');
const ModbusClient = require('../lib/ModbusClient');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'modbus');
const ABSENT = 0x8000; // what the server answers for an address the dump lacks

/** A Modbus TCP server answering function 0x03 from `holding` ({ address: word }). */
const serve = (holding) => new Promise((resolve) => {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.on('data', (frame) => {
      if (frame.readUInt8(7) !== 0x03) return;
      const address = frame.readUInt16BE(8);
      const count = frame.readUInt16BE(10);
      const reply = Buffer.alloc(9 + count * 2);
      frame.copy(reply, 0, 0, 4);
      reply.writeUInt16BE(3 + count * 2, 4);
      reply.writeUInt8(frame.readUInt8(6), 6);
      reply.writeUInt8(0x03, 7);
      reply.writeUInt8(count * 2, 8);
      for (let i = 0; i < count; i += 1) reply.writeUInt16BE(holding[address + i] ?? ABSENT, 9 + i * 2);
      socket.write(reply);
    });
  });
  server.listen(0, '127.0.0.1', () => resolve(server));
});

/** What each driver should make of a dump: per unit the expected values (a subset). */
const CASES = [
  {
    dump: 'se17k_3phase',
    inverter_modbus: [{
      measure_power: 865, 'measure_voltage.1': 228.9, 'measure_voltage.2': 230, 'measure_voltage.3': 227.5, inverter_status: 'production', alarm_problem: false,
    }],
    meter_modbus: 'none',
    battery_modbus: 'none',
  },
  {
    dump: 'issue913_u1',
    inverter_modbus: [{
      measure_power: 9490, meter_power: 18785.652, 'measure_voltage.1': 250.2, measure_frequency: 50.04, inverter_status: 'production',
    }],
    // positive export in the register: import positive here
    meter_modbus: [{ measure_power: -5279 }],
    battery_modbus: [{
      measure_power: 0, measure_battery: 100, measure_soh: 100, battery_charging_state: 'idle',
    }, { measure_battery: 99 }],
  },
  {
    dump: 'issue827_u1',
    inverter_modbus: [{ measure_power: -5008, inverter_status: 'off' }],
    meter_modbus: [{ measure_power: -3484 }, { measure_power: -2471 }, { measure_power: -2740 }],
    battery_modbus: [{
      measure_power: 5002, measure_battery: 67, battery_charging_state: 'charging', alarm_problem: false,
    }],
  },
  {
    dump: 'issue944_u1',
    battery_modbus: [{ measure_power: -66, battery_charging_state: 'discharging', measure_soh: 98 }, { measure_power: -66 }],
  },
  {
    dump: 'issue565_u3',
    inverter_modbus: 'none', // the EV charger answers as an inverter, without telemetry
  },
];

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const runDriver = async ({
  dump, driverId, port, expected,
}) => {
  const driver = loadDriver(driverId);
  await driver.onInit();
  let offered;
  try {
    offered = await driver.findDevices({ host: '127.0.0.1', port, unitId: 1 });
  } catch (error) {
    check(expected === 'none', `${dump} ${driverId}: pairing threw ${error.message}`);
    if (expected === 'none') check(error.message === driver.homey.__('errors.modbusNoUnits'), `${dump} ${driverId}: ${error.message}`);
    return;
  }
  check(expected !== 'none', `${dump} ${driverId}: offered ${offered.length} device(s), expected none`);
  check(offered.length === expected.length, `${dump} ${driverId}: offered ${offered.length}, expected ${expected.length}`);

  const DeviceClass = require(path.join(ROOT, 'drivers', driverId, 'device.js')); // eslint-disable-line import/no-dynamic-require, global-require
  for (const [index, offer] of offered.entries()) {
    const device = new DeviceClass({ driverManifest: driver.manifest, data: offer.data, settings: { ...offer.settings } });
    device.store = structuredClone(offer.store);
    device.blocks = device.definition.blocks(device.base).map((block) => ({ ...block, failures: 0 }));
    device.unmappedLogged = new Set();
    device.client = new ModbusClient({ host: '127.0.0.1', port, timeout: 1000 });
    try {
      await device.runDetection(); // eslint-disable-line no-await-in-loop
      await device.poll(); // eslint-disable-line no-await-in-loop
    } finally {
      device.client.destroy();
    }
    const values = Object.fromEntries(device.getCapabilities().map((id) => [id, device.getCapabilityValue(id)]));
    for (const [id, value] of Object.entries(expected[index] || {})) {
      check(isDeepStrictEqual(values[id], value), `${dump} ${driverId} ${index + 1}: ${id} is ${values[id]}, expected ${value}`);
    }
    check(device.available, `${dump} ${driverId} ${index + 1}: unavailable (${device.unavailableMessage})`);
    check(Boolean(device.getSetting('deviceSn')), `${dump} ${driverId} ${index + 1}: no serial number on the settings page`);
    device.problems.forEach((problem) => failures.push(`${dump} ${driverId} ${index + 1}: ${problem}`));
    console.log(`  ${dump} ${driverId} ${index + 1} (${offer.data.id}): ${JSON.stringify(values)}`);
  }
};

(async () => {
  const modbusDrivers = manifest.drivers.filter((driver) => driver.connectivity.includes('lan')).map((driver) => driver.id);
  for (const testCase of CASES) {
    const { holding } = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${testCase.dump}.json`), 'utf8'));
    const server = await serve(Object.fromEntries(Object.entries(holding).map(([address, word]) => [Number(address), word]))); // eslint-disable-line no-await-in-loop
    try {
      for (const driverId of modbusDrivers.filter((id) => testCase[id])) {
        // eslint-disable-next-line no-await-in-loop
        await runDriver({
          dump: testCase.dump, driverId, port: server.address().port, expected: testCase[driverId],
        });
      }
    } finally {
      server.close();
    }
  }
  if (failures.length) {
    console.error(`FAIL - ${failures.length} problem(s):\n`);
    failures.forEach((failure) => console.error(`  ${failure}`));
    process.exitCode = 1;
  } else {
    console.log(`OK - modbus: ${CASES.length} register dumps paired and polled`);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
