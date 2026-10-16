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

/** float32 <-> two registers, low word first (SolarEdge's 0xF000 blocks). */
const floatWords = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeFloatBE(value, 0);
  return [bytes.readUInt16BE(2), bytes.readUInt16BE(0)];
};
const wordsFloat = (low, high) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt16BE(high, 0);
  bytes.writeUInt16BE(low, 2);
  return bytes.readFloatBE(0);
};
const setFloat = (holding, address, value) => {
  [holding[address], holding[address + 1]] = floatWords(value); // eslint-disable-line no-param-reassign
};

/**
 * A Modbus TCP server answering function 0x03 from `holding` ({ address: word }); 0x06 and 0x10
 * write into it. `holding.rejectWrites`: acknowledge but keep the value, as Dijker's inverter did.
 */
const serve = (holding) => new Promise((resolve) => {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.on('data', (frame) => {
      const fc = frame.readUInt8(7);
      if (fc === 0x06 || fc === 0x10) {
        const address = frame.readUInt16BE(8);
        const words = fc === 0x06 ? [frame.readUInt16BE(10)]
          : Array.from({ length: frame.readUInt16BE(10) }, (_, i) => frame.readUInt16BE(13 + i * 2));
        if (!holding.rejectWrites) {
          words.forEach((word, i) => {
            holding[address + i] = word;
          });
        } // eslint-disable-line no-param-reassign
        const reply = Buffer.from(frame.subarray(0, 12)); // 0x06 echoes; 0x10 answers address and count
        reply.writeUInt16BE(6, 4);
        socket.write(reply);
        return;
      }
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
      measure_power: 865,
      'measure_power.dc': 878,
      measure_efficiency: 98.5,
      'measure_voltage.dc': 746.9,
      'measure_voltage.1': 228.9,
      'measure_voltage.2': 230,
      'measure_voltage.3': 227.5,
      inverter_status: 'production',
      alarm_problem: false,
    }],
    meter_modbus: 'none',
    battery_modbus: 'none',
    settings: { inverter_modbus: { ratedPower: '17000 W' } }, // no 0xF304: from the model name
    // 2500 W of a 17 kW inverter without enhanced dynamic power control: 15 % in 0xF001
    control: {
      driverId: 'inverter_modbus',
      capability: 'target_power',
      value: 2500,
      read: (holding) => holding[0xf001],
      reset: (holding) => {
        holding[0xf001] = 100;
      }, // eslint-disable-line no-param-reassign
      written: 15,
      tile: 2550,
      options: { min: 0, max: 17000, step: 170 },
    },
  },
  {
    // the same inverter with Dijker's enhanced dynamic power control block (read live 2026-10-16)
    dump: 'se17k_3phase',
    inject: (holding) => {
      holding[0xf300] = 1; // eslint-disable-line no-param-reassign
      setFloat(holding, 0xf304, 5250);
      setFloat(holding, 0xf30c, 5250);
      [holding[0xf310], holding[0xf311]] = [550, 0]; // eslint-disable-line no-param-reassign
      setFloat(holding, 0xf312, 100);
      setFloat(holding, 0xf322, 100);
    },
    inverter_modbus: [{ measure_power: 865, target_power: 5250 }],
    settings: { inverter_modbus: { ratedPower: '5250 W' } }, // read from 0xF304
    // 2500 W of 5250 W: 47.62 % in 0xF322, float32
    control: {
      driverId: 'inverter_modbus',
      capability: 'target_power',
      value: 2500,
      read: (holding) => Math.round(wordsFloat(holding[0xf322], holding[0xf323]) * 100) / 100,
      reset: (holding) => setFloat(holding, 0xf322, 100),
      written: 47.62,
      tile: 2500,
      options: { min: 0, max: 5250, step: 10 },
    },
  },
  {
    dump: 'issue913_u1',
    inverter_modbus: [{
      measure_power: 9490, measure_efficiency: 98.5, meter_power: 18785.652, 'measure_voltage.1': 250.2, measure_frequency: 50.04, inverter_status: 'production',
    }],
    // positive export in the register: import positive here
    meter_modbus: [{ measure_power: -5279 }],
    battery_modbus: [{
      measure_power: 0, measure_battery: 100, measure_soh: 100, battery_charging_state: 'idle',
    }, { measure_battery: 99 }],
  },
  {
    dump: 'issue827_u1',
    // charging the battery from the grid at night: no DC -> AC conversion, so no efficiency
    inverter_modbus: [{ measure_power: -5008, measure_efficiency: null, inverter_status: 'off' }],
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

/** Let the poll a control schedules (POLL_AFTER_WRITE, immediate in the harness) finish. */
const settle = async (device) => {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  while (device.polling) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
};

/** Run the case's control on `device`, then fake an inverter restart. */
const runControl = async ({
  dump, device, holding, control,
}) => {
  const name = `${dump} ${control.driverId} ${control.capability}`;
  check(isDeepStrictEqual(device.options?.[control.capability], { ...device.driverManifest.capabilitiesOptions[control.capability], ...control.options }),
    `${name}: options ${JSON.stringify(device.options?.[control.capability])}`);
  const definition = device.controls.find((item) => item.capability === control.capability);
  await device.runControl(definition, control.value);
  await settle(device);
  check(control.read(holding) === control.written, `${name}: wrote ${control.read(holding)}, expected ${control.written}`);
  check(device.getCapabilityValue(control.capability) === control.tile, `${name}: tile shows ${device.getCapabilityValue(control.capability)}`);
  control.reset(holding);
  await device.poll();
  check(control.read(holding) === control.written, `${name}: not written again after a reset to 100 (${control.read(holding)})`);

  holding.rejectWrites = true; // eslint-disable-line no-param-reassign
  control.reset(holding);
  const logged = device.problems.length;
  const rejected = await device.runControl(definition, control.value).then(() => null, (error) => error);
  device.problems.splice(logged); // the expected 'control failed' log line
  check(rejected?.message === device.homey.__('errors.powerLimitRejected'), `${name}: an ignored write gave ${rejected?.message}`);
  holding.rejectWrites = false; // eslint-disable-line no-param-reassign
};

const runDriver = async ({
  dump, driverId, port, expected, holding, control, settings,
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
      if (control?.driverId === driverId) {
        await runControl({ // eslint-disable-line no-await-in-loop
          dump, device, holding, control,
        });
      }
    } finally {
      device.client.destroy();
    }
    const values = Object.fromEntries(device.getCapabilities().map((id) => [id, device.getCapabilityValue(id)]));
    for (const [id, value] of Object.entries(expected[index] || {})) {
      check(isDeepStrictEqual(values[id], value), `${dump} ${driverId} ${index + 1}: ${id} is ${values[id]}, expected ${value}`);
    }
    check(device.available, `${dump} ${driverId} ${index + 1}: unavailable (${device.unavailableMessage})`);
    check(Boolean(device.getSetting('deviceSn')), `${dump} ${driverId} ${index + 1}: no serial number on the settings page`);
    for (const [key, value] of Object.entries(settings?.[driverId] || {})) {
      check(device.getSetting(key) === value, `${dump} ${driverId} ${index + 1}: setting ${key} is ${device.getSetting(key)}, expected ${value}`);
    }
    device.problems.forEach((problem) => failures.push(`${dump} ${driverId} ${index + 1}: ${problem}`));
    console.log(`  ${dump} ${driverId} ${index + 1} (${offer.data.id}): ${JSON.stringify(values)}`);
  }
};

(async () => {
  const modbusDrivers = manifest.drivers.filter((driver) => driver.connectivity.includes('lan')).map((driver) => driver.id);
  for (const testCase of CASES) {
    const { holding } = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${testCase.dump}.json`), 'utf8'));
    const registers = Object.fromEntries(Object.entries(holding).map(([address, word]) => [Number(address), word]));
    if (testCase.inject) testCase.inject(registers);
    const server = await serve(registers); // eslint-disable-line no-await-in-loop
    try {
      for (const driverId of modbusDrivers.filter((id) => testCase[id])) {
        // eslint-disable-next-line no-await-in-loop
        await runDriver({
          dump: testCase.dump, driverId, port: server.address().port, expected: testCase[driverId], holding: registers, control: testCase.control, settings: testCase.settings,
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
