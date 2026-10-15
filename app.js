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

const Homey = require('homey');
const SolarEdgeCloudClient = require('./lib/SolarEdgeCloudClient');
const { POLL_EVENT, POLL_INTERVAL } = require('./lib/solarEdgeConstants');

const clientId = ({ username, password }) => JSON.stringify([username, password]);

module.exports = class SolarEdgeApp extends Homey.App {

  async onInit() {
    this.clients = new Map();
    this.registerFlowListeners();
    this.startPolling();
    this.log('SolarEdge app initialized');
  }

  /**
   * The shared API client per account: one session for all devices of that account.
   * @returns {SolarEdgeCloudClient}
   */
  getClient({ username, password }) {
    const id = clientId({ username, password });
    if (!this.clients.has(id)) this.clients.set(id, this.newClient({ username, password }));
    return this.clients.get(id);
  }

  newClient({ username, password }) {
    return new SolarEdgeCloudClient({
      username,
      password,
      log: (...args) => this.log('[client]', ...args),
      error: (...args) => this.error('[client]', ...args),
    });
  }

  /**
   * Log in with a device's changed credentials and switch the device to them; throws when the login
   * fails. A new password for the same account moves all its devices along, so none keeps logging
   * in with the old one. Clients no device uses any more are dropped.
   */
  async changeCredentials({ device, oldSettings, newSettings }) {
    const credentials = { username: newSettings.username, password: newSettings.password };
    const id = clientId(credentials);
    const client = this.clients.get(id) || this.newClient(credentials);
    await client.login();
    this.clients.set(id, client);

    const devices = this.getDevices();
    const moving = [device];
    if (oldSettings.username === newSettings.username) {
      const oldId = clientId(oldSettings);
      moving.push(...devices.filter((other) => other !== device && clientId(other.getSettings()) === oldId));
    }
    for (const other of moving) {
      // setSettings does not call onSettings (SDK docs)
      // eslint-disable-next-line no-await-in-loop
      if (other !== device) await other.setSettings(credentials);
      other.connect(credentials);
    }

    const inUse = new Set(devices.map((other) => other.client));
    for (const [key, unused] of this.clients) {
      if (!inUse.has(unused)) this.clients.delete(key);
    }
  }

  getDevices() {
    return Object.values(this.homey.drivers.getDrivers()).flatMap((driver) => driver.getDevices());
  }

  registerFlowListeners() {
    this.homey.flow.getActionCard('home-load-controller-set-state')
      .registerRunListener(async ({ device, state }) => {
        await device.triggerCapabilityListener('solaredge-home-load-controller-state', state);
      });
  }

  startPolling() {
    this.pollInterval = this.homey.setInterval(() => this.homey.emit(POLL_EVENT), POLL_INTERVAL);
    this.log(`poll job started, every ${POLL_INTERVAL / 1000} seconds`);
  }

  async onUninit() {
    if (this.pollInterval) this.homey.clearInterval(this.pollInterval);
  }

};
