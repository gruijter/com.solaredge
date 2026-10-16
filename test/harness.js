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
 * The app's drivers and devices outside Homey, for capture.js and responses.js: a stubbed `homey`
 * module, a client that records or replays API calls, and pairing plus one poll per device.
 */

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const homeyLib = require('homey-lib'); // eslint-disable-line node/no-unpublished-require

const ROOT = path.join(__dirname, '..');
const CAPTURES = path.join(__dirname, 'captures');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'en.json'), 'utf8'));

/** The capability definition: system ones from homey-lib, custom ones from app.json. */
const capabilityDefinition = (id) => manifest.capabilities?.[id] || homeyLib.getCapability(id.split('.')[0]);

/** Why `value` is not valid for the capability, or null. */
/** `options`: the driver's capabilitiesOptions and runtime options, which override the definition. */
const invalidValue = (id, value, options = {}) => {
  if (value === null) return null;
  const {
    type, min, max, values,
  } = { ...capabilityDefinition(id), ...options };
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `not a finite number: ${value}`;
    if (min !== undefined && value < min) return `below ${min}: ${value}`;
    if (max !== undefined && value > max) return `above ${max}: ${value}`;
    return null;
  }
  if (type === 'boolean') return typeof value === 'boolean' ? null : `not a boolean: ${value}`;
  if (type === 'enum') return values.some((item) => item.id === value) ? null : `not one of its values: ${value}`;
  return null;
};

const homey = {
  manifest,
  __: (key, tokens = {}) => {
    if (typeof key === 'object') return key.en;
    const text = key.split('.').reduce((node, part) => node?.[part], en) ?? key;
    return text.replace(/__(\w+)__/g, (match, token) => String(tokens[token] ?? match));
  },
  clock: { getTimezone: () => 'UTC' },
  i18n: { getLanguage: () => 'en' },
  // pastYearTotals waits a second between years to spare the API; the replay need not
  setTimeout: (fn) => setImmediate(fn),
  // timers are driven by the tests themselves
  setInterval: () => ({}),
  clearInterval: () => {},
  on() {},
  removeListener() {},
  emit() {},
  flow: {
    getActionCard: () => ({
      registerRunListener() {
        return this;
      },
    }),
  },
  // Modbus pairing: mDNS sees nothing, the scan runs on loopback
  discovery: { getStrategy: () => ({ getDiscoveryResults: () => ({}) }) },
  cloud: { getLocalAddress: async () => '127.0.0.1:80' },
};

class SimpleClass {

  log() {}

}

/** Homey.Device as far as the devices use it; `problems` collects what would go wrong in Homey. */
class Device extends SimpleClass {

  /** `capabilities`: the device's own list, as an older version left it; default the manifest's. */
  constructor({
    driverManifest, data, settings, capabilities = driverManifest.capabilities, energy = driverManifest.energy ?? null,
  }) {
    super();
    this.homey = homey;
    this.driverManifest = driverManifest;
    this.driver = { id: driverManifest.id, manifest: driverManifest };
    this.data = data;
    this.settings = settings;
    this.values = Object.fromEntries(capabilities.map((id) => [id, null]));
    this.energy = energy;
    this.store = {};
    this.available = true;
    this.problems = [];
  }

  getName() {
    return this.driverManifest.id;
  }

  getData() {
    return this.data;
  }

  getSettings() {
    return this.settings;
  }

  getSetting(key) {
    return this.settings[key];
  }

  async setSettings(settings) {
    Object.assign(this.settings, settings);
  }

  hasCapability(id) {
    return id in this.values;
  }

  getCapabilities() {
    return Object.keys(this.values);
  }

  getCapabilityValue(id) {
    return this.values[id] ?? null;
  }

  async addCapability(id) {
    if (!this.hasCapability(id)) this.values[id] = null;
  }

  async removeCapability(id) {
    delete this.values[id];
    if (this.options) delete this.options[id];
  }

  // throws without options of its own, as Homey does (homey-app-development skill, section 18)
  getCapabilityOptions(id) {
    if (!this.options?.[id]) throw new Error(`Invalid Capability: ${id}`);
    return this.options[id];
  }

  async setCapabilityOptions(id, options) {
    if (!this.hasCapability(id)) throw new Error(`Invalid Capability: ${id}`);
    this.options = { ...this.options, [id]: options };
  }

  getEnergy() {
    return this.energy;
  }

  async setEnergy(energy) {
    this.energy = energy;
  }

  async setCapabilityValue(id, value) {
    if (!this.hasCapability(id)) throw new Error(`Invalid Capability: ${id}`);
    const invalid = invalidValue(id, value, { ...this.driverManifest.capabilitiesOptions?.[id], ...this.options?.[id] });
    if (invalid) this.problems.push(`${id} ${invalid}`);
    this.values[id] = value;
  }

  // null for a key never set, as Homey (seen live 2026-10-16, Paul's Homey Pro mini)
  getStoreValue(key) {
    return this.store[key] ?? null;
  }

  async setStoreValue(key, value) {
    this.store[key] = value;
  }

  getAvailable() {
    return this.available;
  }

  async setAvailable() {
    this.available = true;
  }

  async setUnavailable(message) {
    this.available = false;
    this.unavailableMessage = message;
  }

  async setWarning(message) {
    this.warning = message;
  }

  registerCapabilityListener() {}

  registerMultipleCapabilityListener(capabilities, listener) {
    this.capabilityListeners = { ...this.capabilityListeners, [capabilities.join()]: listener };
  }

  error(...args) {
    this.problems.push(`error: ${args.map((arg) => arg?.message ?? arg).join(' ')}`);
  }

}

class Driver extends SimpleClass {

  error() {}

}

// require('homey') in app code gets the stub
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === 'homey') return 'homey-stub';
  return originalResolve.call(this, request, ...rest);
};
require.cache['homey-stub'] = {
  id: 'homey-stub',
  filename: 'homey-stub',
  loaded: true,
  exports: {
    App: SimpleClass, Device, Driver, SimpleClass,
  },
};

const errorOf = (error) => ({
  message: error.message, name: error.name, code: error.code, status: error.status,
});

/** Argument objects as a key that ignores property order. */
const callKey = (method, args) => `${method} ${JSON.stringify(Object.fromEntries(Object.entries(args ?? {}).sort()))}`;

/**
 * A client that passes reads to `client` and records them; writes are refused, so a capture never
 * changes anything on the site.
 */
const recordingClient = (client) => {
  const calls = new Map();
  const proxy = new Proxy(client, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      if (property.startsWith('set')) {
        return async () => {
          throw new Error(`capture is read-only: ${property}`);
        };
      }
      if (!property.startsWith('get')) return value.bind(target);
      return async (args) => {
        const key = callKey(property, args);
        try {
          const result = await value.call(target, args);
          if (!calls.has(key)) calls.set(key, { method: property, args, result });
          return result;
        } catch (error) {
          if (!calls.has(key)) calls.set(key, { method: property, args, error: errorOf(error) });
          throw error;
        }
      };
    },
  });
  return { client: proxy, calls };
};

/** A client that answers from recorded calls, and throws on a call that was not recorded. */
const replayClient = (calls) => {
  const byKey = new Map(calls.map((call) => [callKey(call.method, call.args), call]));
  return new Proxy({}, {
    get(target, property) {
      if (typeof property !== 'string' || !/^(get|set)[A-Z]/.test(property)) return undefined;
      return async (args) => {
        const call = byKey.get(callKey(property, args));
        if (!call) throw new Error(`not captured: ${callKey(property, args)}`);
        if (call.error) throw Object.assign(new Error(call.error.message), call.error);
        return structuredClone(call.result);
      };
    },
  });
};

const RealDate = Date;

/** Date and Date.now() fixed at `time` (epoch ms), so a replay asks for the same periods. */
const freezeTime = (time) => {
  globalThis.Date = class extends RealDate {

    constructor(...args) {
      super(...(args.length ? args : [time]));
    }

    static now() {
      return time;
    }

  };
};

const loadDriver = (id) => {
  const DriverClass = require(path.join(ROOT, 'drivers', id, 'driver.js')); // eslint-disable-line import/no-dynamic-require, global-require
  const driver = new DriverClass();
  driver.homey = homey;
  driver.id = id;
  driver.manifest = manifest.drivers.find((item) => item.id === id);
  return driver;
};

/**
 * Pair every driver on `site`, then poll each offered device once, with the energy totals. A device
 * starts with the capabilities and store pairing gave it.
 * @returns {Promise<object[]>} per driver: { driverId, offered, devices: [{ device, offer, thrown }] }
 */
const pairAndPoll = async ({ client, site }) => {
  const results = [];
  // the cloud drivers; the Modbus ones (connectivity lan) answer no cloud API
  for (const { id } of manifest.drivers.filter((item) => item.connectivity.includes('cloud'))) {
    const driver = loadDriver(id);
    const result = { driverId: id, devices: [] };
    results.push(result);
    try {
      result.offered = await driver.pairDevices({ client, site }); // eslint-disable-line no-await-in-loop
    } catch (error) {
      result.thrown = error;
      continue;
    }
    for (const offer of result.offered) {
      const DeviceClass = require(path.join(ROOT, 'drivers', id, 'device.js')); // eslint-disable-line import/no-dynamic-require, global-require
      const device = new DeviceClass({
        driverManifest: driver.manifest,
        data: { ...offer.data, siteId: site.id },
        settings: { ...offer.settings },
        capabilities: offer.capabilities,
      });
      device.store = structuredClone(offer.store);
      device.client = client;
      device.energyPending = true;
      const entry = { device, offer };
      result.devices.push(entry);
      try {
        await device.onPoll(); // eslint-disable-line no-await-in-loop
        // the meter's yearly totals run outside the poll
        await device.getTotalPromise; // eslint-disable-line no-await-in-loop
      } catch (error) {
        entry.thrown = error;
      }
    }
  }
  return results;
};

module.exports = {
  CAPTURES,
  manifest,
  loadDriver,
  freezeTime,
  pairAndPoll,
  recordingClient,
  replayClient,
};
