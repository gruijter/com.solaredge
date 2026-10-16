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
 * The flow cards in the built app.json against the code:
 * 1. every condition and action has a run listener, and nothing else is registered;
 * 2. the `<capability>_is` conditions answer from the capability value, and their dropdowns, like
 *    those of the actions that set an enum, offer exactly the enum's values;
 * 3. every `<capability>_changed` / `_true` / `_false` trigger names a capability its driver can
 *    have, a `_changed` one with a token of that name. These and the `_is` conditions show only
 *    devices with the capability (device filter capabilities=). Homey runs these itself (homey-app-development
 *    skill section 17), so the code may not trigger them.
 */

const fs = require('node:fs');
const path = require('node:path');
const { manifest } = require('./harness');
const deviceCapabilities = require('../lib/deviceCapabilities');

const ROOT = path.join(__dirname, '..');
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const registered = { conditions: {}, actions: {}, triggers: {} };
const card = (kind) => (id) => ({
  registerRunListener(listener) {
    registered[kind][id] = listener;
    return this;
  },
  trigger: async () => {
    registered.triggers[id] = true;
  },
});

const App = require(path.join(ROOT, 'app.js')); // eslint-disable-line import/no-dynamic-require
const app = Object.create(App.prototype);
app.homey = {
  flow: {
    getConditionCard: card('conditions'), getActionCard: card('actions'), getDeviceTriggerCard: card('triggers'), getTriggerCard: card('triggers'),
  },
};
app.registerFlowListeners();

// the Modbus drivers register their own action cards
const driverInits = manifest.drivers.filter((driver) => driver.connectivity.includes('lan')).map((driver) => {
  const Driver = require(path.join(ROOT, 'drivers', driver.id, 'driver.js')); // eslint-disable-line import/no-dynamic-require, global-require
  const instance = Object.create(Driver.prototype);
  Object.assign(instance, { homey: app.homey, id: driver.id, log: () => {} });
  return instance.onInit();
});

// --- 1. listeners -------------------------------------------------------------------------

// after the drivers' onInit, in run()
const checkListeners = () => {
  for (const kind of ['conditions', 'actions']) {
    const declared = (manifest.flow[kind] || []).map((item) => item.id);
    declared.filter((id) => !registered[kind][id]).forEach((id) => failures.push(`${kind} ${id}: no run listener`));
    Object.keys(registered[kind]).filter((id) => !declared.includes(id)).forEach((id) => failures.push(`${kind} ${id}: listener for a card that is not declared`));
  }
};

// --- 2. conditions on a capability value --------------------------------------------------

const fakeDevice = (capability, value) => ({
  hasCapability: (id) => id === capability,
  getCapabilityValue: (id) => (id === capability ? value : null),
});

// the actions with a dropdown of an enum capability's values
const ACTION_ENUMS = { 'home-load-controller-set-state': 'solaredge-home-load-controller-state' };

/** The dropdown of card `id` offers the values of the enum `capability`, in the same order. */
const checkEnum = (id, dropdown, capability) => {
  const definition = manifest.capabilities?.[capability];
  if (definition?.type !== 'enum') return;
  const offered = dropdown.values.map((value) => value.id).join();
  const values = definition.values.map((value) => value.id).join();
  check(offered === values, `${id}: dropdown ${offered}, ${capability} has ${values}`);
};

const run = async () => {
  await Promise.all(driverInits);
  checkListeners();
  // the Modbus action cards hand their value to the device's control or action
  const calls = [];
  const device = {
    setControl: async (values) => calls.push(['setControl', values]),
    runAction: async (name, args) => calls.push(['runAction', name, args]),
  };
  const ACTION_CALLS = {
    set_export_limit: [{ watts: 2000 }, ['setControl', { export_limit: 2000 }]],
    set_backup_reserve: [{ soc: 30 }, ['setControl', { battery_min_soc: 30 }]],
    set_session_energy_limit: [{ kwh: 20 }, ['setControl', { session_energy_limit: 20 }]],
    set_charging_phases: [{ phases: '1' }, ['runAction', 'chargingPhases', { phases: '1' }]],
  };
  for (const [id, [args, expected]] of Object.entries(ACTION_CALLS)) {
    calls.length = 0;
    await registered.actions[id]?.({ device, ...args }); // eslint-disable-line no-await-in-loop
    check(JSON.stringify(calls) === JSON.stringify([expected]), `${id}: called ${JSON.stringify(calls)}`);
  }

  for (const action of manifest.flow.actions || []) {
    const dropdown = (action.args || []).find((arg) => arg.type === 'dropdown');
    if (dropdown && ACTION_ENUMS[action.id]) checkEnum(action.id, dropdown, ACTION_ENUMS[action.id]);
  }

  for (const condition of manifest.flow.conditions || []) {
    const listener = registered.conditions[condition.id];
    const capability = condition.id.replace(/_is$/, '');
    const filter = condition.args.find((arg) => arg.type === 'device')?.filter || '';
    if (capability !== condition.id) check(new URLSearchParams(filter).get('capabilities') === capability, `${condition.id}: device filter ${filter} lacks capabilities=${capability}`);
    if (!listener || capability === condition.id) continue;
    const dropdown = condition.args.find((arg) => arg.type === 'dropdown');
    if (dropdown) checkEnum(condition.id, dropdown, capability);
    if (dropdown) {
      const [first, second] = dropdown.values.map((value) => value.id);
      const args = (id) => ({ device: fakeDevice(capability, first), [dropdown.name]: id });
      check(await listener(args(first)) === true, `${condition.id}: false for its own value ${first}`); // eslint-disable-line no-await-in-loop
      check(await listener(args(second)) === false, `${condition.id}: true for ${second} while ${first}`); // eslint-disable-line no-await-in-loop
      check(await listener({ device: fakeDevice('other', first), [dropdown.name]: first }) === false, `${condition.id}: true without the capability`); // eslint-disable-line no-await-in-loop
    } else {
      check(await listener({ device: fakeDevice(capability, true) }) === true, `${condition.id}: false while true`); // eslint-disable-line no-await-in-loop
      check(await listener({ device: fakeDevice(capability, false) }) === false, `${condition.id}: true while false`); // eslint-disable-line no-await-in-loop
    }
  }

  // --- 3. triggers Homey runs itself ------------------------------------------------------

  const possible = Object.fromEntries(manifest.drivers.map((driver) => {
    return [driver.id, new Set([...driver.capabilities, ...deviceCapabilities.order(driver.id), ...deviceCapabilities.optional(driver.id),
      ...deviceCapabilities.legacy(driver.id)])];
  }));
  const code = ['app.js', ...fs.readdirSync(path.join(ROOT, 'lib')).map((file) => path.join('lib', file)),
    ...manifest.drivers.flatMap((driver) => ['driver.js', 'device.js'].map((file) => path.join('drivers', driver.id, file)))]
    .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
  for (const trigger of manifest.flow.triggers || []) {
    const match = trigger.id.match(/^(.+)_(changed|true|false)$/);
    if (!match) continue;
    const [, capability, kind] = match;
    const filter = trigger.args.find((arg) => arg.type === 'device')?.filter || '';
    // driver_id=a|b: a card shared by several drivers
    for (const driverId of (new URLSearchParams(filter).get('driver_id') || '').split('|')) {
      check(possible[driverId]?.has(capability), `trigger ${trigger.id}: ${driverId} never has ${capability}`);
    }
    check(new URLSearchParams(filter).get('capabilities') === capability, `trigger ${trigger.id}: device filter ${filter} lacks capabilities=${capability}`);
    if (kind === 'changed') check(trigger.tokens?.some((token) => token.name === capability), `trigger ${trigger.id}: no token ${capability}`);
    const type = manifest.capabilities?.[capability]?.type;
    if (kind !== 'changed') check(type === undefined || type === 'boolean', `trigger ${trigger.id}: ${capability} is ${type}, not boolean`);
    check(!registered.triggers[trigger.id] && !code.includes(`'${trigger.id}'`), `trigger ${trigger.id}: run by the app as well as by Homey`);
  }

};

run().then(() => {
  if (failures.length) {
    console.error(`FAIL - ${failures.length} problem(s):\n`);
    failures.forEach((failure) => console.error(`  ${failure}`));
    process.exitCode = 1;
  } else {
    const count = (kind) => (manifest.flow[kind] || []).length;
    console.log(`OK - flows: ${count('triggers')} triggers run by Homey, ${count('conditions')} conditions and ${count('actions')} actions with listeners`);
  }
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
