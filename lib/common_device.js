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
const { FIRST_YEAR, LOG_CREDENTIALS, POLL_EVENT } = require('./solarEdgeConstants');
const userErrorText = require('./userErrorText');
const DeviceMigrator = require('./DeviceMigrator');
const deviceCapabilities = require('./deviceCapabilities');
const capture = require('./solarEdgeCapture');
const { dateIn, monotonic, raiseListenerCeiling } = require('./deviceHelpers');

/** Hide all but the first two characters of a credential. */
const obfuscate = (value) => (value ? `${String(value).slice(0, 2)}***` : value);

module.exports = class CommonDevice extends Homey.Device {

  async onInit() {
    this.polling = false;
    this.energyPending = false;
    this.log(`${this.getName()} settings:`, this.loggableSettings());
    const { refreshToken, ...store } = this.getStore();
    this.log(`${this.getName()} data:`, JSON.stringify(this.getData()), 'store:', JSON.stringify(store), refreshToken ? '+ refresh token' : '');
    capture.arm(`device restart: ${this.getName()}`);
    // before the first poll writes to the capabilities
    await this.migrate();
    this.connect(this.getSettings());
    this.startPolling();
    this.log(`${this.getName()} has been initialized`);
  }

  /** Bring the capabilities, their order and the energy object in line with the driver. */
  async migrate() {
    try {
      const changed = await DeviceMigrator.migrateCapabilities(this, this.capabilityList());
      await DeviceMigrator.migrateEnergy(this);
      // a re-added capability is back on the manifest's options
      await DeviceMigrator.syncCapabilityOptions(this, this.capabilityOptions(), { force: changed });
    } catch (error) {
      this.error(error);
    }
  }

  /** The capabilities this device should have (lib/deviceCapabilities.js). */
  capabilityList() {
    return deviceCapabilities.list(this.driver.id, this.driver.manifest.capabilities, this.getStoreValue('seenCaps') || {},
      (capability) => this.hasCapability(capability));
  }

  /**
   * Options that paired devices must have as well: the manifest's decimals. Homey stores the value
   * rounded to them, not only the display (confirmed live 2026-10-15). Whether Homey applies a
   * changed manifest option to a paired device is not verified; syncCapabilityOptions writes it
   * only where the device's options differ.
   * @returns {Object<string, object>} capability id -> options
   */
  capabilityOptions() {
    const wanted = {};
    for (const [capability, options] of Object.entries(this.driver.manifest.capabilitiesOptions || {})) {
      if (this.hasCapability(capability) && options.decimals !== undefined) wanted[capability] = { decimals: options.decimals };
    }
    return wanted;
  }

  /**
   * Record the optional capabilities among `values` ({ capability: value }) that have a value, and
   * add them: those pairing did not see. Never withdrawn: removing a capability breaks the flows
   * that use it.
   */
  async recordSeenCaps(values) {
    const seen = this.getStoreValue('seenCaps') || {};
    const fresh = deviceCapabilities.seenIn(this.driver.id, values).filter((capability) => !seen[capability]);
    if (!fresh.length) return;
    fresh.forEach((capability) => {
      seen[capability] = true;
    });
    await this.setStoreValue('seenCaps', seen);
    this.log(`${this.getName()} reports new capabilities:`, fresh);
    await this.migrate();
  }

  /** See deviceHelpers.monotonic. */
  async monotonic(name, reading) {
    return monotonic(this, name, reading);
  }

  /** Log once per app run for each distinct `key`: an unknown API value, a first reading. */
  logOnce(key, ...args) {
    if (!this.loggedOnce) this.loggedOnce = new Set();
    if (this.loggedOnce.has(key)) return;
    this.loggedOnce.add(key);
    this.log(this.getName(), ...args);
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

  /** Today in the site's timezone as YYYY-MM-DD. */
  async siteToday() {
    return dateIn(new Date(), await this.siteTimeZone());
  }

  /** When the site was installed (installationDate), in its timezone; null when unknown. */
  async siteInstalled() {
    const installed = new Date((await this.site()).installationDate ?? NaN);
    return Number.isNaN(installed.getTime()) ? null : dateIn(installed, await this.siteTimeZone());
  }

  /** The first day of the site's data as YYYY-MM-DD: its installationDate, else FIRST_YEAR. */
  async siteStartDate() {
    return (await this.siteInstalled()) ?? `${FIRST_YEAR}-01-01`;
  }

  /** Whether a site that is not ONLINE is expected: no connectivity alarm then; per driver. */
  async offlineExpected() {
    return false;
  }

  /**
   * alarm_connectivity from the site's communication status, alarm_problem from its open alerts;
   * each only for a device that has it. Any status but 'ONLINE' is an alarm, unless
   * offlineExpected().
   */
  async updateSiteAlarms() {
    const { siteId } = this.getData();
    if (this.hasCapability('alarm_connectivity')) {
      const { connectivityStatus } = await this.client.getSiteCommunication({ siteId });
      if (typeof connectivityStatus === 'string') {
        this.logOnce(`connectivity ${connectivityStatus}`, 'site connectivity', connectivityStatus);
        const offline = connectivityStatus !== 'ONLINE' && !(await this.offlineExpected());
        await this.setCapability('alarm_connectivity', offline);
      }
    }
    if (this.hasCapability('alarm_problem')) {
      const { totalAlertsCount, topAlerts } = await this.client.getSiteAlerts({ siteId });
      if (typeof totalAlertsCount === 'number') await this.setCapability('alarm_problem', totalAlertsCount > 0);
      // topAlerts[].name, e.g. 'Panel underperforming' (pmichael/solaredge-ha-web-client tests)
      (topAlerts || []).forEach((alert) => this.logOnce(`alert ${JSON.stringify(alert)}`, 'site alert', JSON.stringify(alert)));
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
    // kept by app.js#storeRefreshToken; one of another account (changed username) is not used
    const kept = this.getStoreValue('refreshToken');
    if (kept?.username === username) this.client.useRefreshToken(kept.token);
    // a token issued before this device used the client: a refresh brings no new one
    const { refreshToken } = this.client;
    if (refreshToken && kept?.token !== refreshToken) {
      this.setStoreValue('refreshToken', { username, token: refreshToken }).catch((error) => this.error(error));
    }
    this.homey.app.startPolling(this.client, pollInterval);
  }

  startPolling() {
    this.stopPolling();
    this.onPollRequested = (client, { energy } = {}) => {
      if (client !== this.client) return;
      this.poll({ energy }).catch((error) => this.error(error));
    };
    raiseListenerCeiling(this.homey, POLL_EVENT);
    this.homey.on(POLL_EVENT, this.onPollRequested);
    this.poll({ energy: true }).catch((error) => this.error(error));
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

  /** True once per energy tick of the account (lib/solarEdgeTiming.js), and on the first poll. */
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
    // the account's ticks and session end with its last device
    this.homey.app.dropUnusedClients(this.homey.app.getDevices().filter((other) => other !== this));
    this.log('Device was deleted', this.getName());
  }

  async onUninit() {
    this.stopPolling();
  }

};
