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
const pointMap = require('../lib/solarEdgePointMap');

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

/** A uint32 as KEBA serves it: two registers, high word first. */
const setKeba = (holding, address, value) => {
  holding[address] = Math.floor(value / 0x10000); // eslint-disable-line no-param-reassign
  holding[address + 1] = value % 0x10000; // eslint-disable-line no-param-reassign
};

/** Run `values` as a Flow action would; the error, or null. */
const act = async (device, values) => {
  const logged = device.problems.length;
  const result = await device.setControl(values).then(() => null, (error) => error);
  if (result) device.problems.splice(logged); // the 'control failed' log line of a refusal
  await settle(device);
  return result;
};

const floatAt = (holding, address) => Math.round(wordsFloat(holding[address], holding[address + 1]) * 100) / 100;

/** Advanced power control on (Power Control Open Protocol p. 16), which the dumps do not show. */
const advancedPowerControl = (holding) => {
  [holding[0xf104], holding[0xf105], holding[0xf142], holding[0xf143]] = [4, 0, 1, 0]; // eslint-disable-line no-param-reassign
};

const CASES = [
  {
    dump: 'se17k_3phase',
    inverter_modbus: [{
      measure_power: 865,
      'measure_voltage.dc': 746.9,
      'measure_voltage.1': 228.9,
      'measure_voltage.2': 230,
      'measure_voltage.3': 227.5,
      inverter_status: 'production',
      alarm_problem: false,
    }],
    meter_modbus: 'none',
    battery_modbus: 'none',
    settings: {
      // no 0xF304: from the model name
      inverter_modbus: { ratedPower: '17000 W', phases: '3', powerControl: 'Basic' },
    },
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
    settings: {
      // read from 0xF304
      inverter_modbus: { ratedPower: '5250 W', phases: '3', powerControl: 'Dynamic, back to 100 % after 550 s without a command' },
    },
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
    // nothing but a number from the user may lower the limit: an empty store or value is no 0 %
    scenario: {
      inverter_modbus: async ({ device, holding, name }) => {
        setFloat(holding, 0xf322, 100);
        await device.setStoreValue('powerLimit', null);
        await device.poll();
        check(floatAt(holding, 0xf322) === 100, `${name}: an empty stored limit wrote ${floatAt(holding, 0xf322)} %`);
        const refused = await act(device, { target_power: null });
        check(refused?.message === device.homey.__('errors.powerLimitUnknown') && floatAt(holding, 0xf322) === 100,
          `${name}: a null target power wrote ${floatAt(holding, 0xf322)} % (${refused?.message})`);
        // the dynamic command is renewed on its own timer, within a third of 0xF310
        const control = device.controls.find((item) => item.capabilities.includes('target_power'));
        check(control.keepAliveSeconds(device) === 183, `${name}: keep-alive every ${control.keepAliveSeconds(device)} s`);
        await act(device, { target_power: 2500 });
        setFloat(holding, 0xf322, 100);
        await device.keepAlive();
        check(floatAt(holding, 0xf322) === 47.62, `${name}: keep-alive wrote ${floatAt(holding, 0xf322)} %`);
        // an app stop keeps the limit, a deleted device lifts it
        await device.releaseControls();
        check(floatAt(holding, 0xf322) === 47.62, `${name}: an app stop left ${floatAt(holding, 0xf322)} %`);
        await device.releaseControls({ deleted: true });
        check(floatAt(holding, 0xf322) === 100, `${name}: a deleted device left ${floatAt(holding, 0xf322)} %`);
      },
    },
  },
  {
    dump: 'issue913_u1',
    inverter_modbus: [{
      measure_power: 9490, meter_power: 18785.652, 'measure_voltage.1': 250.2, measure_frequency: 50.04, inverter_status: 'production',
    }],
    // positive export in the register: import positive here
    meter_modbus: [{ measure_power: -5279 }],
    battery_modbus: [{
      measure_power: 0,
      measure_battery: 100,
      measure_soh: 100,
      battery_charging_state: 'idle',
      // the dumps lack the lifetime counters: the server's 0x8000 words are not implemented
      'meter_power.charged': null,
      'meter_power.discharged': null,
    }, { measure_battery: 99 }],
    // the dump lacks the charge and discharge power ratings
    settings: {
      inverter_modbus: { phases: '1' },
      meter_modbus: { phases: '3' }, // wye; the dump lacks the meter common block
      battery_modbus: { ratedEnergy: '9.7 kWh', maxChargePower: '', maxDischargePower: '' },
    },
  },
  {
    dump: 'issue827_u1',
    // charging the battery from the grid at night
    inverter_modbus: [{ measure_power: -5008, inverter_status: 'off' }],
    meter_modbus: [{ measure_power: -3484 }, { measure_power: -2471 }, { measure_power: -2740 }],
    battery_modbus: [{
      measure_power: 5002, measure_battery: 67, battery_charging_state: 'charging', alarm_problem: false,
    }],
  },
  {
    dump: 'issue944_u1',
    battery_modbus: [{
      measure_power: -66,
      battery_charging_state: 'discharging',
      measure_soh: 98,
      target_power_mode: 'time_of_use',
      battery_min_soc: 6,
      'meter_power.charged': null,
    }, { measure_power: -66 }],
    // the dump shows no advanced power control: remote control is refused, nothing written
    scenario: {
      battery_modbus: async ({ device, holding, name }) => {
        if (!device.hasCapability('target_power')) return;
        const refused = await act(device, { target_power: 1000 });
        check(refused?.message === device.homey.__('errors.advancedPowerControlOff'), `${name}: ${refused?.message}`);
        check(holding[0xe004] === 2, `${name}: storage mode ${holding[0xe004]} after a refusal`);
      },
    },
  },
  {
    // issue913 with advanced power control on: remote control through the 1st battery
    dump: 'issue913_u1',
    inject: advancedPowerControl,
    battery_modbus: [{ target_power_mode: 'self_use', battery_min_soc: 2 }, {}],
    scenario: {
      battery_modbus: async ({
        device, holding, index, name,
      }) => {
        if (index === 1) {
          // one control block for all batteries of the inverter
          check(!device.hasCapability('target_power') && !device.hasCapability('battery_min_soc'), `${name}: controls on the 2nd battery`);
          return;
        }
        check(await act(device, { target_power: 2000 }) === null, `${name}: charging refused`);
        check(holding[0xe004] === 4 && holding[0xe00a] === 1 && holding[0xe00b] === 60 && holding[0xe00d] === 3
          && floatAt(holding, 0xe00e) === 2000, `${name}: charge command ${[0xe004, 0xe00a, 0xe00b, 0xe00d].map((a) => holding[a])} ${floatAt(holding, 0xe00e)}`);
        await device.poll();
        check(device.getCapabilityValue('target_power_mode') === 'homey', `${name}: mode ${device.getCapabilityValue('target_power_mode')}`);
        await act(device, { target_power: -1500 });
        check(holding[0xe00d] === 4 && floatAt(holding, 0xe010) === 1500, `${name}: discharge command ${holding[0xe00d]} ${floatAt(holding, 0xe010)}`);
        holding[0xe00d] = 0; // eslint-disable-line no-param-reassign
        await device.keepAlive();
        check(holding[0xe00d] === 4, `${name}: keep-alive did not renew the command (${holding[0xe00d]})`);
        await act(device, { target_power_mode: 'force_charge' });
        check(holding[0xe00d] === 3 && floatAt(holding, 0xe00e) === 5000, `${name}: force charge ${holding[0xe00d]} ${floatAt(holding, 0xe00e)}`);
        await device.releaseControls();
        check(holding[0xe00d] === 1, `${name}: release left command mode ${holding[0xe00d]}`);
        await act(device, { target_power_mode: 'self_use' });
        await device.poll();
        check(holding[0xe004] === 1 && device.getCapabilityValue('target_power_mode') === 'self_use', `${name}: back to self-use ${holding[0xe004]}`);
        await act(device, { battery_min_soc: 30 });
        check(floatAt(holding, 0xe008) === 30, `${name}: backup reserve ${floatAt(holding, 0xe008)}`);
      },
    },
  },
  {
    // export limitation on, as an installer sets it up with a grid meter
    dump: 'se17k_3phase',
    inject: (holding) => {
      holding[0xe000] = 1; // eslint-disable-line no-param-reassign
      setFloat(holding, 0xe002, 4000);
    },
    inverter_modbus: [{ export_limit: 4000 }],
    scenario: {
      inverter_modbus: async ({ device, holding, name }) => {
        check(device.options?.export_limit?.max === 17000, `${name}: export limit options ${JSON.stringify(device.options?.export_limit)}`);
        check(await act(device, { export_limit: 2500 }) === null, `${name}: export limit refused`);
        check(floatAt(holding, 0xe002) === 2500 && device.getCapabilityValue('export_limit') === 2500, `${name}: site limit ${floatAt(holding, 0xe002)}`);
        holding[0xe000] = 0; // eslint-disable-line no-param-reassign
        const refused = await act(device, { export_limit: 1000 });
        check(refused?.message === device.homey.__('errors.exportLimitOff'), `${name}: with export limitation off: ${refused?.message}`);
      },
    },
  },
  {
    // a charging KEBA P30 on 3 phases: 11 kW at 16 A
    dump: 'keba_synthetic',
    registers: () => {
      const holding = {};
      [[1000, 3], [1004, 7], [1006, 0], [1008, 16000], [1014, 18416854], [1016, 304111], [1018, 0x030A0D00],
        [1020, 11000000], [1036, 123456789], [1502, 52000]].forEach(([address, value]) => setKeba(holding, address, value));
      return holding;
    },
    evcharger_modbus: [{
      measure_power: 11000,
      evcharger_charging: true,
      evcharger_charging_state: 'plugged_in_charging',
      'meter_power.session': 5.2,
      'meter_power.charged': 12345.679,
      target_power: 22080,
      target_power_mode: 'device',
    }],
    settings: { evcharger_modbus: { deviceModel: 'KeContact P30 c-series', firmware: '3.10.13', ratedCurrent: '32 A' } },
    scenario: {
      evcharger_modbus: async ({ device, holding, name }) => {
        // 6900 W on the 3 phases it charges on: 10 A, with the failsafe armed
        check(await act(device, { target_power: 6900 }) === null, `${name}: target power refused`);
        check(holding[5004] === 10000 && holding[5016] === 6000 && holding[5018] === 60 && holding[5014] === undefined,
          `${name}: current ${[5004, 5016, 5018, 5014].map((a) => holding[a])}`);
        check(device.getCapabilityValue('target_power_mode') === 'homey', `${name}: mode ${device.getCapabilityValue('target_power_mode')}`);
        await act(device, { evcharger_charging: false });
        holding[5004] = 0; // eslint-disable-line no-param-reassign
        await device.keepAlive();
        check(holding[5014] === 0 && holding[5004] === 0, `${name}: stopped, yet the keep-alive wrote ${holding[5004]}`);
        await act(device, { evcharger_charging: true });
        check(holding[5014] === 1 && holding[5004] === 10000, `${name}: start ${holding[5014]} ${holding[5004]}`);
        // a target of 0 W stops and a higher one starts again; a stop by the user stays
        await act(device, { target_power: 0 });
        check(holding[5014] === 0, `${name}: 0 W left charging ${holding[5014]}`);
        await act(device, { target_power: 6900 });
        check(holding[5014] === 1, `${name}: back from 0 W charging ${holding[5014]}`);
        await act(device, { evcharger_charging: false });
        await act(device, { target_power: 4600 });
        check(holding[5014] === 0, `${name}: a new target undid the user's stop`);
        await act(device, { evcharger_charging: true });
        await act(device, { session_energy_limit: 20 });
        await device.poll();
        check(holding[5010] === 2000 && device.getCapabilityValue('session_energy_limit') === 20, `${name}: session limit ${holding[5010]}`);
        const logged = device.problems.length;
        const off = await device.runAction('chargingPhases', { phases: '1' }).then(() => null, (error) => error);
        device.problems.splice(logged); // the expected 'action failed' log line
        check(off?.message === device.homey.__('errors.phaseSwitchingOff'), `${name}: phases without the setting: ${off?.message}`);
        await device.onSettings({ newSettings: { phaseSwitching: true }, changedKeys: ['phaseSwitching'] });
        await device.setSettings({ phaseSwitching: true });
        await device.runAction('chargingPhases', { phases: '1' });
        check(holding[5050] === 3 && holding[5052] === 0, `${name}: phase switching ${holding[5050]} ${holding[5052]}`);
        await device.releaseControls();
        check(holding[5018] === 0 && holding[5004] === 63000, `${name}: release ${holding[5018]} ${holding[5004]}`);
        setKeba(holding, 1004, 1);
        await settle(device);
        await device.poll();
        check(device.getCapabilityValue('session_energy_limit') === null, `${name}: session limit after unplugging`);
        const refused = await act(device, { evcharger_charging: true });
        check(refused?.message === device.homey.__('errors.noCarConnected'), `${name}: start without a car: ${refused?.message}`);
      },
    },
  },
  {
    dump: 'issue565_u3',
    inverter_modbus: 'none', // the EV charger answers as an inverter, without telemetry
  },
];

/** Run the case's control on `device`, then fake an inverter restart. */
const runControl = async ({
  dump, device, holding, control,
}) => {
  const name = `${dump} ${control.driverId} ${control.capability}`;
  check(isDeepStrictEqual(device.options?.[control.capability], { ...device.driverManifest.capabilitiesOptions[control.capability], ...control.options }),
    `${name}: options ${JSON.stringify(device.options?.[control.capability])}`);
  const definition = device.controls.find((item) => item.capabilities.includes(control.capability));
  await device.runControl(definition, { [control.capability]: control.value });
  await settle(device);
  check(control.read(holding) === control.written, `${name}: wrote ${control.read(holding)}, expected ${control.written}`);
  check(device.getCapabilityValue(control.capability) === control.tile, `${name}: tile shows ${device.getCapabilityValue(control.capability)}`);
  control.reset(holding);
  await device.poll();
  check(control.read(holding) === control.written, `${name}: not written again after a reset to 100 (${control.read(holding)})`);

  holding.rejectWrites = true; // eslint-disable-line no-param-reassign
  control.reset(holding);
  const logged = device.problems.length;
  const rejected = await device.runControl(definition, { [control.capability]: control.value }).then(() => null, (error) => error);
  device.problems.splice(logged); // the expected 'control failed' log line
  check(rejected?.message === device.homey.__('errors.powerLimitRejected'), `${name}: an ignored write gave ${rejected?.message}`);
  holding.rejectWrites = false; // eslint-disable-line no-param-reassign
};

const runDriver = async ({
  dump, driverId, port, expected, holding, control, settings, scenario,
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
    let values;
    try {
      await device.runDetection(); // eslint-disable-line no-await-in-loop
      await device.registerControls(); // eslint-disable-line no-await-in-loop
      await device.poll(); // eslint-disable-line no-await-in-loop
      values = Object.fromEntries(device.getCapabilities().map((id) => [id, device.getCapabilityValue(id)]));
      if (control?.driverId === driverId) {
        await runControl({ // eslint-disable-line no-await-in-loop
          dump, device, holding, control,
        });
      }
      if (scenario?.[driverId]) {
        // eslint-disable-next-line no-await-in-loop
        await scenario[driverId]({
          device, holding, index, name: `${dump} ${driverId} ${index + 1}`,
        });
      }
    } finally {
      device.client.destroy();
    }
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

// the KEBA examples of the programmers guide (3.7-3.9); no register dump of a charger
const kebaIdentity = () => {
  const words = (value) => [Math.floor(value / 0x10000), value % 0x10000];
  const regs = new Map([1014, 1016, 1018].flatMap((address, index) => {
    const [high, low] = words([18416854, 304111, 0x030A0D00][index]);
    return [[address, high], [address + 1, low]];
  }));
  const identity = pointMap.evcharger_modbus.identity(regs);
  check(isDeepStrictEqual(identity, {
    manufacturer: 'KEBA', model: 'KeContact P30 c-series', firmware: '3.10.13', serialNumber: '18416854', settings: { ratedCurrent: '32 A' },
  }), `KEBA identity: ${JSON.stringify(identity)}`);
};

/** Decisions that need no server: a refused storage block, falling battery counters, meter roles. */
const unitChecks = async () => {
  const { detect } = pointMap.battery_modbus;
  check(!('storageControl' in detect(new Map(), {}, 0, new Set())), 'battery: a storage block that timed out was judged absent');
  check(detect(new Map(), {}, 0, new Set([0xe004])).storageControl === false, 'battery: a refused storage block was not judged absent');

  const store = {};
  const device = {
    base: 0,
    log() {},
    getName: () => 'battery',
    getStoreValue: (key) => store[key] ?? null,
    setStoreValue: async (key, value) => {
      store[key] = value;
    },
  };
  const charged = pointMap.battery_modbus.capabilities['meter_power.charged'];
  const counter = (wh) => {
    const words = [0, 0, 0, 0].map((_, i) => Math.floor(wh / (0x10000 ** i)) % 0x10000); // uint64, low word first
    return new Map(words.map((word, i) => [57600 + 122 + i, word]));
  };
  const results = [];
  for (const wh of [5000, 6000, 1000, 1500, 2000]) results.push(await charged(counter(wh), device)); // eslint-disable-line no-await-in-loop
  check(isDeepStrictEqual(results, [5, 6, 6, 6, 6.5]), `battery: charged after a reset ${JSON.stringify(results)}`);

  const meter = (meterFunction) => pointMap.meter_modbus.energy({
    getSetting: () => meterFunction, driver: { manifest: { energy: { cumulative: true } } },
  });
  check(meter('Export+Import').cumulative === true && meter('').cumulative === true, 'meter: the grid meter is not cumulative');
  check(meter('Production').cumulative === undefined, 'meter: a production meter is cumulative');
};

/**
 * Pairing discovery against the fake server on loopback: the scan of 127.0.0.0/24, mDNS (which the
 * scan then skips), and no offer for another SunSpec brand.
 */
const discovery = async () => {
  const load = (dump) => Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(FIXTURES, `${dump}.json`), 'utf8')).holding)
    .map(([address, word]) => [Number(address), word]));
  const holding = load('se17k_3phase');
  const server = await serve(holding);
  const { port } = server.address();
  try {
    const driver = loadDriver('inverter_modbus');
    await driver.onInit();
    driver.scanPorts = () => [port];
    const scanned = await driver.discover();
    check(isDeepStrictEqual(scanned, [{
      host: '127.0.0.1', port, unitId: 1, count: 1,
    }]), `discovery by scan: ${JSON.stringify(scanned)}`);

    // a server the app is connected to already: not probed, but checked over that connection
    const { pool } = driver.homey.app;
    const held = pool.acquire({ host: '127.0.0.1', port, unitId: 1 });
    const pooled = await driver.discover();
    const entry = pool.entries.get(`127.0.0.1:${port}#1`);
    check(isDeepStrictEqual(pooled, scanned) && entry?.client === held && entry.refs === 1 && !held.destroyed,
      `discovery next to a connected device: ${JSON.stringify(pooled)}, refs ${entry?.refs}`);
    pool.release({ host: '127.0.0.1', port, unitId: 1 });

    driver.homey = {
      ...driver.homey,
      discovery: { getStrategy: () => ({ getDiscoveryResults: () => ({ a: { address: '127.0.0.1', port: String(port), txt: { modbus_id: '1' } } }) }) },
      cloud: {
        getLocalAddress: async () => {
          throw Error('no scan expected');
        },
      },
    };
    const announced = await driver.discover();
    check(announced.length === 1 && announced[0].port === port, `discovery by mDNS: ${JSON.stringify(announced)}`);

    // "Fronius" in the common block
    [holding[40004], holding[40005], holding[40006], holding[40007]] = [0x4672, 0x6f6e, 0x6975, 0x7300];
    driver.homey = loadDriver('inverter_modbus').homey;
    check((await driver.discover()).length === 0, 'discovery offered a non-SolarEdge SunSpec inverter');
  } finally {
    server.close();
  }
};

(async () => {
  kebaIdentity();
  await unitChecks();
  await discovery();
  const modbusDrivers = manifest.drivers.filter((driver) => driver.connectivity.includes('lan')).map((driver) => driver.id);
  for (const testCase of CASES) {
    const { holding } = testCase.registers
      ? { holding: testCase.registers() }
      : JSON.parse(fs.readFileSync(path.join(FIXTURES, `${testCase.dump}.json`), 'utf8'));
    const registers = Object.fromEntries(Object.entries(holding).map(([address, word]) => [Number(address), word]));
    if (testCase.inject) testCase.inject(registers);
    const server = await serve(registers); // eslint-disable-line no-await-in-loop
    try {
      for (const driverId of modbusDrivers.filter((id) => testCase[id])) {
        // eslint-disable-next-line no-await-in-loop
        await runDriver({
          dump: testCase.dump,
          driverId,
          port: server.address().port,
          expected: testCase[driverId],
          holding: registers,
          control: testCase.control,
          settings: testCase.settings,
          scenario: testCase.scenario,
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
