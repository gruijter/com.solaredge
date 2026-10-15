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
const { LOG_CREDENTIALS, POLL_EVENT } = require('./solarEdgeConstants');
const userErrorText = require('./userErrorText');
const DeviceMigrator = require('./DeviceMigrator');

/** Hide all but the first two characters of a credential. */
const obfuscate = (value) => (value ? `${String(value).slice(0, 2)}***` : value);

module.exports = class CommonDevice extends Homey.Device {

  async onInit() {
    this.polling = false;
    this.energyPending = false;
    this.log(`${this.getName()} settings:`, this.loggableSettings());
    // before the first poll writes to the capabilities
    await this.migrate();
    this.connect(this.getSettings());
    this.startPolling();
    this.log(`${this.getName()} has been initialized`);
  }

  /** Bring the capabilities, their order and the energy object in line with the driver. */
  async migrate() {
    try {
      await DeviceMigrator.migrateCapabilities(this, this.capabilityList());
      await DeviceMigrator.migrateEnergy(this);
    } catch (error) {
      this.error(error);
    }
  }

  /**
   * The capabilities this device should have, in capabilityOrder(): the driver's, the optional
   * ones it reported (store `seenCaps`) and the legacy ones it still has.
   */
  capabilityList() {
    const seen = this.getStoreValue('seenCaps') || {};
    const has = new Set([
      ...this.driver.manifest.capabilities,
      ...this.optionalCapabilities().filter((capability) => seen[capability]),
      ...this.legacyCapabilities().filter((capability) => this.hasCapability(capability)),
    ]);
    const order = this.capabilityOrder();
    return [...order.filter((capability) => has.has(capability)), ...[...has].filter((capability) => !order.includes(capability))];
  }

  /** Every capability the device can have, in tile order; per driver. */
  capabilityOrder() {
    return this.driver.manifest.capabilities;
  }

  /** Capabilities added only once the API reports a value for them; per driver. */
  optionalCapabilities() {
    return [];
  }

  /** Capabilities no longer in the driver that stay on devices which have them; per driver. */
  legacyCapabilities() {
    return [];
  }

  /**
   * Record the optional capabilities among `values` ({ capability: value }) that have a value, and
   * add them. Never withdrawn: removing a capability breaks the flows that use it.
   */
  async recordSeenCaps(values) {
    const seen = this.getStoreValue('seenCaps') || {};
    const fresh = this.optionalCapabilities()
      .filter((capability) => !seen[capability] && values[capability] !== null && values[capability] !== undefined);
    if (!fresh.length) return;
    fresh.forEach((capability) => {
      seen[capability] = true;
    });
    await this.setStoreValue('seenCaps', seen);
    this.log(`${this.getName()} reports new capabilities:`, fresh);
    await this.migrate();
  }

  /** The site from the account's sites list (installationDate, timezone); fetched once per app run. */
  async site() {
    if (!this.siteInfo) {
      const { siteId } = this.getData();
      const sites = await this.client.getSites();
      this.siteInfo = Object.values(sites).find((site) => String(site.id) === String(siteId)) || {};
    }
    return this.siteInfo;
  }

  /** The site's timezone, else Homey's. */
  async siteTimeZone() {
    return (await this.site()).timezone || this.homey.clock.getTimezone();
  }

  /**
   * alarm_connectivity from the site's communication status, alarm_problem from its open alerts;
   * each only for a device that has it. Only 'ONLINE' was seen live; any other status is an alarm.
   */
  async updateSiteAlarms() {
    const { siteId } = this.getData();
    if (this.hasCapability('alarm_connectivity')) {
      const { connectivityStatus } = await this.client.getSiteCommunication({ siteId });
      if (typeof connectivityStatus === 'string') await this.setCapability('alarm_connectivity', connectivityStatus !== 'ONLINE');
    }
    if (this.hasCapability('alarm_problem')) {
      const { totalAlertsCount } = await this.client.getSiteAlerts({ siteId });
      if (typeof totalAlertsCount === 'number') await this.setCapability('alarm_problem', totalAlertsCount > 0);
    }
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

  /** Take the app-wide client of the account in `settings`, and make sure its tick runs. */
  connect({ username, password, poll_interval: pollInterval }) {
    this.client = this.homey.app.getClient({ username, password });
    this.homey.app.startPolling(this.client, pollInterval);
  }

  startPolling() {
    this.stopPolling();
    this.onPollRequested = (client, { energy } = {}) => {
      if (client !== this.client) return;
      this.poll({ energy }).catch((error) => this.error(error));
    };
    this.raiseListenerCeiling();
    this.homey.on(POLL_EVENT, this.onPollRequested);
    this.poll({ energy: true }).catch((error) => this.error(error));
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

  /** @param {object} [options] @param {boolean} [options.energy] fetch the energy totals too */
  async poll({ energy = false } = {}) {
    // a tick that is skipped keeps its energy request for the next poll
    if (energy) this.energyPending = true;
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

  /** True once per energy tick of the account (ENERGY_POLL_INTERVAL), and on the first poll. */
  energyDue() {
    const due = this.energyPending;
    this.energyPending = false;
    return due;
  }

  async setCapability(capability, value) {
    if (this.hasCapability(capability) && value !== undefined && !Number.isNaN(value)) {
      await this.setCapabilityValue(capability, value).catch((error) => {
        this.log(error, capability, value);
      });
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('username') || changedKeys.includes('password')) {
      // a throw makes Homey keep the old settings
      await this.homey.app.changeCredentials({ device: this, oldSettings, newSettings })
        .catch((error) => {
          throw new Error(userErrorText(this.homey, error));
        });
      this.poll({ energy: true }).catch((error) => this.error(error));
    }
    if (changedKeys.includes('poll_interval')) {
      await this.homey.app.changePollInterval({ device: this, interval: newSettings.poll_interval });
    }
  }

  onDeleted() {
    this.stopPolling();
    this.log('Device was deleted', this.getName());
  }

  async onUninit() {
    this.stopPolling();
  }

};
