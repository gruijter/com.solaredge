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
const { ENERGY_POLL_INTERVAL, LOG_CREDENTIALS, POLL_EVENT } = require('./solarEdgeConstants');
const userErrorText = require('./userErrorText');

/** Hide all but the first two characters of a credential. */
const obfuscate = (value) => (value ? `${String(value).slice(0, 2)}***` : value);

module.exports = class CommonDevice extends Homey.Device {

  async onInit() {
    this.polling = false;
    this.lastEnergyPoll = 0;
    this.log(`${this.getName()} settings:`, this.loggableSettings());
    this.connect(this.getSettings());
    this.startPolling();
    this.log(`${this.getName()} has been initialized`);
  }

  /** The device settings for the log; credentials readable only while LOG_CREDENTIALS is on. */
  loggableSettings() {
    const settings = { ...this.getSettings() };
    if (!LOG_CREDENTIALS) {
      settings.username = obfuscate(settings.username);
      settings.password = obfuscate(settings.password);
    }
    return settings;
  }

  /** Take the app-wide client of the account in `settings`. */
  connect({ username, password }) {
    this.client = this.homey.app.getClient({ username, password });
  }

  startPolling() {
    this.stopPolling();
    this.onPollRequested = () => {
      this.poll().catch((error) => this.error(error));
    };
    this.raiseListenerCeiling();
    this.homey.on(POLL_EVENT, this.onPollRequested);
    this.poll().catch((error) => this.error(error));
  }

  // this.homey is an EventEmitter (default ceiling 10) with one poll listener per device
  raiseListenerCeiling() {
    if (typeof this.homey.setMaxListeners !== 'function') return;
    const needed = this.homey.listenerCount(POLL_EVENT) + 12;
    if (this.homey.getMaxListeners() < needed) this.homey.setMaxListeners(needed);
  }

  stopPolling() {
    if (this.onPollRequested) {
      this.homey.removeListener(POLL_EVENT, this.onPollRequested);
      this.onPollRequested = null;
    }
  }

  async poll() {
    // no overlapping polls
    if (this.polling) return;
    this.polling = true;
    try {
      await this.onPoll();
    } catch (error) {
      this.error(`Error Polling: ${error.message}`);
      await this.setUnavailable(userErrorText(this.homey, error)).catch((setError) => this.error(setError));
    } finally {
      this.polling = false;
    }
  }

  /** Read the device's data and set its capabilities and availability; per driver. */
  async onPoll() {
    return undefined;
  }

  /** True at most once per ENERGY_POLL_INTERVAL, counted from the attempt. */
  energyDue() {
    if (Date.now() - this.lastEnergyPoll < ENERGY_POLL_INTERVAL) return false;
    this.lastEnergyPoll = Date.now();
    return true;
  }

  async setCapability(capability, value) {
    if (this.hasCapability(capability) && value !== undefined && !Number.isNaN(value)) {
      await this.setCapabilityValue(capability, value).catch((error) => {
        this.log(error, capability, value);
      });
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (!changedKeys.includes('username') && !changedKeys.includes('password')) return;
    // a throw makes Homey keep the old credentials
    await this.homey.app.changeCredentials({ device: this, oldSettings, newSettings })
      .catch((error) => {
        throw new Error(userErrorText(this.homey, error));
      });
    this.lastEnergyPoll = 0;
    this.poll().catch((error) => this.error(error));
  }

  onDeleted() {
    this.stopPolling();
    this.log('Device was deleted', this.getName());
  }

  async onUninit() {
    this.stopPolling();
  }

};
