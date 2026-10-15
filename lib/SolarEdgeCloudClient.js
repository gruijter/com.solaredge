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

/** An Error with a `code` that callers (and userErrorText) can test for. */
const codedError = (message, code) => Object.assign(new Error(message), { code });

/** A failure of SolarEdge or the network, not of the request itself: worth backing off for. */
const isOutage = (error) => error?.name === 'TimeoutError' || error?.message === 'fetch failed'
  || error?.status >= 500 || error?.status === 429;

module.exports = class SolarEdgeCloudClient {

  // per request; a pairing session caps it further with `deadline`
  static REQUEST_TIMEOUT = 20000;

  // after rejected credentials no automatic login for this long, doubling per rejection
  static LOGIN_RETRY_MIN = 60 * 1000;
  static LOGIN_RETRY_MAX = 60 * 60 * 1000;

  // after an outage the account's ticks pause for twice the poll interval, doubling up to this
  static BACKOFF_MAX = 5 * 60 * 1000;

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
    // epoch ms after which no request may still run (pairing), or null
    this.deadline = null;
    this._loggingIn = null;
    this._loginRetryDelay = 0;
    this._loginBlockedUntil = 0;
    this._inFlight = new Map();
    // ms, set by app.js#setPollInterval
    this.pollInterval = 10000;
    // epoch ms before which app.js skips this account's ticks
    this.backoffUntil = 0;
    this._outages = 0;
  }

  /** Count an outage; the requests of one tick that fail together count once. */
  _noteOutage() {
    if (Date.now() < this.backoffUntil) return;
    this._outages += 1;
    const delay = Math.min(this.pollInterval * 2 ** this._outages, SolarEdgeCloudClient.BACKOFF_MAX);
    this.backoffUntil = Date.now() + delay;
    this.log(`SolarEdge outage, pausing polls for ${Math.round(delay / 1000)} s`);
  }

  isLoggedIn() {
    return this.cookies.length > 0;
  }

  /** The abort signal for one request: REQUEST_TIMEOUT, or less when the deadline is nearer. */
  _signal() {
    let timeout = SolarEdgeCloudClient.REQUEST_TIMEOUT;
    if (this.deadline !== null) timeout = Math.max(0, Math.min(timeout, this.deadline - Date.now()));
    return AbortSignal.timeout(timeout);
  }

  /**
   * Log in and keep the session cookies. A good login answers 302 (redirect to the portal); a
   * server error or rate limit is not taken as rejected credentials.
   */
  async login() {
    const res = await fetch(`${BASE_URL}/solaredge-apigw/api/login`, {
      method: 'POST',
      body: new URLSearchParams({
        j_username: this.username,
        j_password: this.password,
      }),
      // native fetch then returns the 302 itself, with its Set-Cookie headers (verified on Node 24)
      redirect: 'manual',
      signal: this._signal(),
    });
    // unread bodies keep their connection until garbage collection (undici)
    await res.body?.cancel();

    if (res.status >= 500 || res.status === 429) {
      throw Object.assign(new Error(res.statusText || `HTTP ${res.status}`), { status: res.status });
    }

    if (res.status !== 302) {
      this._loginRetryDelay = Math.min(
        this._loginRetryDelay * 2 || SolarEdgeCloudClient.LOGIN_RETRY_MIN,
        SolarEdgeCloudClient.LOGIN_RETRY_MAX,
      );
      this._loginBlockedUntil = Date.now() + this._loginRetryDelay;
      throw codedError('Invalid e-mail and/or password.', 'INVALID_CREDENTIALS');
    }

    this._loginRetryDelay = 0;
    this._loginBlockedUntil = 0;
    this.cookies = res.headers.getSetCookie().map((cookie) => cookie.split(';')[0]);
  }

  /**
   * Log in when there is no session; concurrent callers share one login. After rejected
   * credentials this throws without a login until the retry delay has passed; an explicit
   * login() (settings, pairing) is not held back.
   */
  async ensureLoggedIn() {
    if (this.isLoggedIn()) return;
    if (Date.now() < this._loginBlockedUntil) {
      throw codedError('Invalid e-mail and/or password.', 'INVALID_CREDENTIALS');
    }
    if (!this._loggingIn) {
      this._loggingIn = this.login().finally(() => {
        this._loggingIn = null;
      });
    }
    await this._loggingIn;
  }

  /**
   * One API call with the session cookies. On a 401 it logs in again and retries once.
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
    let pending;
    if (method === 'GET') {
      const key = String(url);
      if (!this._inFlight.has(key)) {
        this._inFlight.set(key, this._request({ url, method, errorText }).finally(() => {
          this._inFlight.delete(key);
        }));
      }
      pending = this._inFlight.get(key);
    } else {
      pending = this._request({
        url, method, body, errorText,
      });
    }

    try {
      const result = await pending;
      this._outages = 0;
      this.backoffUntil = 0;
      return result;
    } catch (error) {
      if (isOutage(error)) this._noteOutage();
      throw error;
    }
  }

  async _request({
    url, method, body, errorText,
  }, isRetry = false) {
    await this.ensureLoggedIn();

    const { cookies } = this;
    const headers = {
      ...SolarEdgeCloudClient.HEADERS,
      Cookie: cookies.join('; '),
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: this._signal(),
    });

    if (res.status === 401) {
      await res.body?.cancel();
      // only this session expired: a login since this request was sent stays
      if (this.cookies === cookies) this.cookies = [];
      if (!isRetry) {
        return this._request({
          url, method, body, errorText,
        }, true);
      }
      throw codedError('Unauthorized', 'UNAUTHORIZED');
    }

    if (!res.ok) {
      // the error code (e.g. GENERAL_ERROR) is what callers test for; it comes as
      // { error: { code } } (seen live); a top-level code is kept as fallback
      const error = await res.json().catch(() => ({
        code: res.statusText,
      }));
      throw Object.assign(new Error(error?.error?.code || error?.code || errorText), { status: res.status });
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
