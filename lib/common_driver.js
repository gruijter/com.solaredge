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
const SolarEdgeCloudClient = require('./SolarEdgeCloudClient');
const userErrorText = require('./userErrorText');

// list_devices must answer within Homey's 30 s pair timeout (skill section 13)
const PAIR_BUDGET = 25000;

module.exports = class CommonDriver extends Homey.Driver {

  async onInit() {
    this.log(`${this.id} driver has been initialized`);
  }

  /**
   * Pairing: mySolarEdge login, then one or more devices per site. The credentials are stored in
   * the device settings.
   * @param {PairSession} session
   */
  onPair(session) {
    let client = null;

    session
      .setHandler('login', async ({ username, password }) => {
        client = new SolarEdgeCloudClient({
          username,
          password,
          log: (...args) => this.log('[client]', ...args),
          error: (...args) => this.error('[client]', ...args),
        });
        try {
          await client.login();
          return true;
        } catch (error) {
          this.error('[Pair] login failed:', error.message);
          // false shows a failed login, a thrown error shows its message (SDK docs, credentials-login)
          if (error.code === 'INVALID_CREDENTIALS') return false;
          throw new Error(userErrorText(this.homey, error));
        }
      })
      .setHandler('list_devices', async () => {
        if (!client) throw new Error(this.homey.__('errors.notLoggedIn'));
        client.deadline = Date.now() + PAIR_BUDGET;
        try {
          return await this.listDevices(client);
        } catch (error) {
          throw new Error(userErrorText(this.homey, error));
        } finally {
          client.deadline = null;
        }
      })
      .setHandler('disconnect', async () => this.log('Pair session disconnected'));
  }

  /** The devices of all sites. A failing site is skipped; its error only shows when none is left. */
  async listDevices(client) {
    const sites = await client.getSites();
    const result = [];
    let siteError = null;

    for (const site of Object.values(sites)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const devices = await this.onPairListDevices({ client, site });
        for (const device of devices) {
          result.push({
            ...device,
            data: {
              ...device.data,
              siteId: site.id,
            },
            settings: {
              ...device.settings,
              username: client.username,
              password: client.password,
            },
          });
        }
      } catch (error) {
        this.error(`[Pair] site ${site.id} failed:`, error.message);
        siteError = siteError || error;
      }
    }

    if (result.length === 0 && siteError) throw siteError;
    return result;
  }

  /**
   * The devices to offer for a site. Default: one device per site, when onPairFilterSite allows it.
   * @returns {Promise<object[]>}
   */
  async onPairListDevices({ client, site }) {
    if (await this.onPairFilterSite({ client, site }) === false) return [];

    return [{
      name: `${site.name} — ${this.homey.__(this.manifest.name)}`,
      data: {},
      settings: {},
    }];
  }

  /**
   * Whether a site has what this driver needs.
   * @returns {Promise<boolean>}
   */
  async onPairFilterSite({ client, site }) { // eslint-disable-line no-unused-vars
    return false;
  }

};
