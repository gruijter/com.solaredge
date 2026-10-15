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
Client for the (unofficial) API behind the mySolarEdge app on monitoring.solaredge.com, with a
cookie session from the web login. Not the public monitoring API.

One client per account (app.js#getClient), shared by all devices of that account: one session
instead of one per device, and identical GETs in flight at the same time go out once.
*/

const BASE_URL = 'https://monitoring.solaredge.com';

module.exports = class SolarEdgeCloudClient {

  // per request, so a stalled response fails before Homey's 30 s pairing timeout
  static REQUEST_TIMEOUT = 20000;

  // the mySolarEdge iOS app's headers
  static HEADERS = {
    'User-Agent': 'SolarEdge/14 CFNetwork/1568.200.51 Darwin/24.1.0',
    'CLIENT-VERSION': '3.12',
  };

  /**
   * @param {object} args
   * @param {string} args.username the mySolarEdge e-mail address
   * @param {string} args.password
   * @param {Function} [args.log]
   * @param {Function} [args.error]
   */
  constructor({
    username, password, log, error,
  } = {}) {
    this.username = username;
    this.password = password;
    this.log = log || (() => {});
    this.error = error || (() => {});
    this.cookies = [];
    this._loggingIn = null;
    this._inFlight = new Map();
  }

  isLoggedIn() {
    return this.cookies.length > 0;
  }

  /** Log in and keep the session cookies. A good login answers 302 (redirect to the portal). */
  async login() {
    const res = await fetch(`${BASE_URL}/solaredge-apigw/api/login`, {
      method: 'POST',
      body: new URLSearchParams({
        j_username: this.username,
        j_password: this.password,
      }),
      // native fetch then returns the 302 itself, with its Set-Cookie headers (verified on Node 24)
      redirect: 'manual',
      signal: AbortSignal.timeout(SolarEdgeCloudClient.REQUEST_TIMEOUT),
    });

    if (res.status !== 302) {
      throw new Error('Invalid e-mail and/or password.');
    }

    this.cookies = res.headers.getSetCookie().map((cookie) => cookie.split(';')[0]);
  }

  /** Log in when there is no session; concurrent callers share one login. */
  async ensureLoggedIn() {
    if (this.isLoggedIn()) return;
    if (!this._loggingIn) {
      this._loggingIn = this.login().finally(() => {
        this._loggingIn = null;
      });
    }
    await this._loggingIn;
  }

  /**
   * One API call with the session cookies. A 401 drops the session, so the next call logs in again.
   * @param {object} args
   * @param {string|URL} args.url
   * @param {string} [args.method]
   * @param {object} [args.body] sent as JSON
   * @param {string} args.errorText the error when the response carries no error code
   * @returns {Promise<object>} the parsed JSON body
   */
  async request({
    url, method = 'GET', body, errorText,
  }) {
    if (method === 'GET') {
      const key = String(url);
      if (!this._inFlight.has(key)) {
        this._inFlight.set(key, this._request({ url, method, errorText }).finally(() => {
          this._inFlight.delete(key);
        }));
      }
      return this._inFlight.get(key);
    }
    return this._request({
      url, method, body, errorText,
    });
  }

  async _request({
    url, method, body, errorText,
  }) {
    await this.ensureLoggedIn();

    const headers = {
      ...SolarEdgeCloudClient.HEADERS,
      Cookie: this.cookies.join('; '),
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(SolarEdgeCloudClient.REQUEST_TIMEOUT),
    });

    if (res.status === 401) {
      this.cookies = [];
      throw new Error('Unauthorized');
    }

    if (!res.ok) {
      // the error code (e.g. INVALID_ARGUMENTS) is what callers test for
      const error = await res.json().catch(() => ({
        code: res.statusText,
      }));
      throw new Error(error?.code || errorText);
    }

    return res.json();
  }

  async getSites() {
    const { sites } = await this.request({
      url: `${BASE_URL}/services/m/so/sites/`,
      errorText: 'Error Getting Sites',
    });
    return sites;
  }

  async getSite({ siteId }) {
    return this.request({
      url: `${BASE_URL}/solaredge-apigw/api/v3/sites/${siteId}`,
      errorText: 'Error Getting Site',
    });
  }

  async getSitePowerflow({ siteId }) {
    return this.request({
      url: `${BASE_URL}/services/m/so/dashboard/v2/site/${siteId}/powerflow/latest?components=consumption%2Cgrid%2Cstorage%2Cev-charger`,
      errorText: 'Error Getting Site Powerflow',
    });
  }

  async getSiteEnergyOverview({ siteId }) {
    return this.request({
      url: `${BASE_URL}/services/m/so/dashboard/site/${siteId}/energyOverview`,
      errorText: 'Error Getting Site Energy Overview',
    });
  }

  /**
   * Energy totals for the period that ends on endDate; `summary.import`/`.export` in Wh.
   * An unknown period throws INVALID_ARGUMENTS.
   */
  async getSiteMeasurements({
    siteId,
    period = 'YEAR',
    measurementUnit = 'WATT_HOUR',
    endDate,
  }) {
    const url = new URL(`${BASE_URL}/services/m/so/dashboard/site/${siteId}/measurements`);
    url.searchParams.append('period', period);
    url.searchParams.append('measurement-unit', measurementUnit);
    url.searchParams.append('end-date', endDate);
    return this.request({
      url,
      errorText: 'Error Getting Site Measurements',
    });
  }

  async getSiteDevices({ siteId }) {
    return this.request({
      url: `${BASE_URL}/services/m/api/homeautomation/v1.0/sites/${siteId}/devices`,
      errorText: 'Error Getting Site Devices',
    });
  }

  async getSiteDeviceApplianceSessionsHistory({
    siteId,
    reporterId,
    startTime = 0,
    endTime = 9999999999999,
  }) {
    return this.request({
      url: `${BASE_URL}/services/m/api/homeautomation/v1.0/${siteId}/devices/${reporterId}/applianceSessionsHistory?timeRange=YEAR&endTime=${endTime}&startTime=${startTime}`,
      errorText: 'Error Getting Site Device Appliance Sessions History',
    });
  }

  async setSiteDeviceApplianceActivationState({
    siteId,
    reporterId,
    state = {},
  }) {
    return this.request({
      url: `${BASE_URL}/services/m/api/homeautomation/v1.0/${siteId}/devices/${reporterId}/activationState`,
      method: 'PUT',
      body: state,
      errorText: 'Error Setting Site Device Appliance Activation State',
    });
  }

};
