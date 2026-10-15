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
const capture = require('./lib/solarEdgeCapture');
const { DEFAULT_POLL_INTERVAL, ENERGY_POLL_INTERVAL, POLL_EVENT } = require('./lib/solarEdgeConstants');

const clientId = ({ username, password }) => JSON.stringify([username, password]);

module.exports = class SolarEdgeApp extends Homey.App {

  async onInit() {
    this.clients = new Map();
    // per client: { timer, lastEnergyTick }
    this.pollers = new Map();
    this.registerFlowListeners();
    // users are asked to restart the app before a diagnostics report
    capture.arm('app start', { force: true });
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

  /** A client whose answers go to the log while capturing is armed (lib/solarEdgeCapture.js). */
  newClient({ username, password }) {
    const client = new SolarEdgeCloudClient({
      username,
      password,
      log: (...args) => this.log('[client]', ...args),
      error: (...args) => this.error('[client]', ...args),
    });
    return capture.wrap(client, (line) => this.log(line));
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
      other.connect(other === device ? newSettings : other.getSettings());
    }

    const inUse = new Set(devices.map((other) => other.client));
    for (const [key, unused] of this.clients) {
      if (inUse.has(unused)) continue;
      this.clients.delete(key);
      this.stopPolling(unused);
    }
  }

  /** A device's changed poll interval (s) holds for its whole account: all its devices follow. */
  async changePollInterval({ device, interval }) {
    for (const other of this.getDevices()) {
      // eslint-disable-next-line no-await-in-loop
      if (other !== device && other.client === device.client) await other.setSettings({ poll_interval: interval });
    }
    this.setPollInterval(device.client, interval);
  }

  getDevices() {
    return Object.values(this.homey.drivers.getDrivers()).flatMap((driver) => driver.getDevices());
  }

  registerFlowListeners() {
    this.homey.flow.getActionCard('home-load-controller-set-state')
      .registerRunListener(async ({ device, state }) => {
        await device.triggerCapabilityListener('solaredge-home-load-controller-state', state);
      });
    this.homey.flow.getActionCard('evcharger-set-auto')
      .registerRunListener(async ({ device }) => device.setAutomatic());
  }

  /**
   * One poll tick per account: all its devices ask at the same moment, so their identical calls go
   * out once (SolarEdgeCloudClient#request). Starts the account's tick unless it already runs.
   * @param {SolarEdgeCloudClient} client
   * @param {number} [interval] seconds
   */
  startPolling(client, interval) {
    if (!this.pollers.has(client)) this.setPollInterval(client, interval);
  }

  setPollInterval(client, interval) {
    const seconds = Number(interval) || DEFAULT_POLL_INTERVAL;
    this.stopPolling(client);
    client.pollInterval = seconds * 1000;
    this.pollers.set(client, {
      timer: this.homey.setInterval(() => this.tick(client), client.pollInterval),
      lastEnergyTick: Date.now(),
    });
    this.log(`polling an account every ${seconds} seconds`);
  }

  stopPolling(client) {
    const poller = this.pollers.get(client);
    if (poller) this.homey.clearInterval(poller.timer);
    this.pollers.delete(client);
  }

  /** Emit a tick for the account's devices; skipped while the client backs off after failures. */
  tick(client) {
    if (Date.now() < client.backoffUntil) return;
    const poller = this.pollers.get(client);
    const energy = Date.now() - poller.lastEnergyTick >= ENERGY_POLL_INTERVAL;
    if (energy) poller.lastEnergyTick = Date.now();
    this.homey.emit(POLL_EVENT, client, { energy });
  }

  async onUninit() {
    for (const client of [...this.pollers.keys()]) this.stopPolling(client);
  }

};
