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
    const id = `${username}|${password}`;
    if (!this.clients.has(id)) {
      this.clients.set(id, new SolarEdgeCloudClient({
        username,
        password,
        log: (...args) => this.log('[client]', ...args),
        error: (...args) => this.error('[client]', ...args),
      }));
    }
    return this.clients.get(id);
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
