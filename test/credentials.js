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
 * The refresh token kept across app restarts (app.js#storeRefreshToken, CommonDevice#connect, the
 * pairing store) and the pairing login's deadline, without a network: the client's requests are stubbed.
 */

const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { manifest, loadDriver } = require('./harness');
const SolarEdgeCloudClient = require('../lib/SolarEdgeCloudClient');
const SolarEdgeApp = require('../app');

const ROOT = path.join(__dirname, '..');
const USERNAME = 'user@example.com';
const SETTINGS = { username: USERNAME, password: 'secret', poll_interval: 10 };
const KEPT = { username: USERNAME, token: 'rt1' };
const PAIR_BUDGET = 25000;

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

/** An app with the inverter devices it is given, and no timers. */
const newApp = () => {
  const app = new SolarEdgeApp();
  const devices = [];
  app.homey = { drivers: { getDrivers: () => ({ inverter: { getDevices: () => devices } }) } };
  app.clients = new Map();
  app.startPolling = () => {};
  app.error = (error) => failures.push(`app error: ${error?.message ?? error}`);
  const DeviceClass = require(path.join(ROOT, 'drivers', 'inverter', 'device.js')); // eslint-disable-line import/no-dynamic-require, global-require
  const driverManifest = manifest.drivers.find((driver) => driver.id === 'inverter');
  const newDevice = (store = {}) => {
    const device = new DeviceClass({ driverManifest, data: { id: `inverter-${devices.length}`, siteId: 1 }, settings: { ...SETTINGS } });
    device.homey = { ...device.homey, app };
    device.store = structuredClone(store);
    devices.push(device);
    return device;
  };
  return { app, newDevice };
};

const tokenStorage = () => {
  const { newDevice } = newApp();
  const first = newDevice();
  const late = newDevice();
  first.connect(SETTINGS);
  first.client._setTokens({ access_token: 'at1', refresh_token: 'rt1', expires_in: 3600 });
  check(isDeepStrictEqual(first.store.refreshToken, KEPT), `token storage: connected device has ${JSON.stringify(first.store.refreshToken)}`);
  check(!late.store.refreshToken, 'token storage: a device not yet connected got the token');
  // connected after the login: a refresh brings no new token, so connect() stores it
  late.connect(SETTINGS);
  check(isDeepStrictEqual(late.store.refreshToken, KEPT), `token storage: late device has ${JSON.stringify(late.store.refreshToken)}`);

  // no longer accepted: removed from every device of the account
  first.client.onRefreshToken(null);
  check(!first.store.refreshToken && !late.store.refreshToken, 'token storage: a rejected token was kept');

  // after a restart the kept token is the client's, so the first renewal needs no password
  const restarted = newApp().newDevice({ refreshToken: KEPT });
  restarted.connect(SETTINGS);
  check(restarted.client.refreshToken === 'rt1', `token storage: restored ${restarted.client.refreshToken}`);

  // one of another account (changed username) is not used, nor overwritten without a token
  const other = { username: 'other@example.com', token: 'rt9' };
  const changed = newApp().newDevice({ refreshToken: other });
  changed.connect(SETTINGS);
  check(changed.client.refreshToken === null && isDeepStrictEqual(changed.store.refreshToken, other),
    `token storage: another account's token gave ${changed.client.refreshToken}`);
};

const pairing = async () => {
  const driver = loadDriver('inverter');
  const handlers = {};
  driver.onPair({
    setHandler(name, handler) {
      handlers[name] = handler;
      return this;
    },
  });
  driver.pairDevices = async () => [{
    name: 'Inverter', data: { id: 'a' }, settings: {}, store: { other: 1 },
  }];
  const { login, getSites } = SolarEdgeCloudClient.prototype;
  let seen = null;
  SolarEdgeCloudClient.prototype.login = async function stubLogin() {
    seen = { client: this, deadline: this.deadline };
    this._setTokens({ access_token: 'at1', refresh_token: 'rt1', expires_in: 3600 });
  };
  SolarEdgeCloudClient.prototype.getSites = async () => ({ 1: { id: 1 } });
  try {
    const started = Date.now();
    check(await handlers.login({ username: USERNAME, password: 'secret' }) === true, 'pairing: login failed');
    check(seen.deadline > started && seen.deadline <= Date.now() + PAIR_BUDGET,
      `pairing: login deadline ${seen.deadline === null ? null : seen.deadline - started} ms`);
    check(seen.client.deadline === null, 'pairing: login deadline not cleared');
    const [offer] = await handlers.list_devices();
    check(isDeepStrictEqual(offer.store, { other: 1, refreshToken: KEPT }), `pairing: store ${JSON.stringify(offer.store)}`);
  } finally {
    Object.assign(SolarEdgeCloudClient.prototype, { login, getSites });
  }
};

(async () => {
  tokenStorage();
  await pairing();
  if (failures.length) {
    console.error(`FAIL - ${failures.length} problem(s):\n`);
    failures.forEach((failure) => console.error(`  ${failure}`));
    process.exitCode = 1;
  } else {
    console.log('OK - credentials: refresh token stored, restored and removed; pairing login deadline and store');
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
