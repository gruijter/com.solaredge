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
cookie session from the web login. Not the public monitoring API. The same session also opens the
web portal's services/layout and services/dashboard endpoints (seen live 2026-10-15).

One client per account (app.js#getClient), shared by all devices of that account: one session
instead of one per device, and identical GETs in flight at the same time go out once.
*/

const BASE_URL = 'https://monitoring.solaredge.com';
const HOME_AUTOMATION_URL = `${BASE_URL}/services/m/api/homeautomation/v1.0`;
const LAYOUT_URL = `${BASE_URL}/services/layout`;
const DASHBOARD_URL = `${BASE_URL}/services/dashboard`;

/** A URL with query parameters; an array value repeats the parameter. */
const withQuery = (url, params = {}) => {
  const result = new URL(url);
  Object.entries(params).forEach(([key, value]) => {
    [].concat(value).forEach((item) => result.searchParams.append(key, item));
  });
  return result;
};

/** An Error with a `code` that callers (and userErrorText) can test for. */
const codedError = (message, code) => Object.assign(new Error(message), { code });

// the message per code of a login that was not accepted
const LOGIN_ERRORS = {
  INVALID_CREDENTIALS: 'Invalid e-mail and/or password.',
  LOGIN_REFUSED: 'SolarEdge refused the login.',
};

/** A failure of SolarEdge or the network, not of the request itself: worth backing off for. */
const isOutage = (error) => error?.name === 'TimeoutError' || error?.message === 'fetch failed'
  || error?.status >= 500 || error?.status === 429;

module.exports = class SolarEdgeCloudClient {

  // per request; a pairing session caps it further with `deadline`
  static REQUEST_TIMEOUT = 20000;

  // after a login that was not accepted no automatic login for this long, doubling per rejection
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
    this._loginBlockedCode = 'INVALID_CREDENTIALS';
    // the cookies of the session that has answered at least once
    this._confirmedCookies = null;
    this._inFlight = new Map();
    // ms, set by app.js#setPollInterval
    this.pollInterval = 10000;
    // epoch ms before which app.js skips this account's ticks
    this.backoffUntil = 0;
    this._outages = 0;
    this._lastSuccessAt = 0;
  }

  /**
   * Count an outage; the requests of one tick that fail together count once. A server error while
   * other requests still succeed (one endpoint failing) is no outage: only a rate limit, or a whole
   * poll interval without any answer, pauses the account's ticks.
   */
  _noteOutage(error) {
    if (Date.now() < this.backoffUntil) return;
    if (error?.status !== 429 && Date.now() - this._lastSuccessAt < this.pollInterval) return;
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
   * Hold back automatic logins after a login that was not accepted, doubling per rejection.
   * @param {string} code a key of LOGIN_ERRORS
   * @returns {Error} the error to throw
   */
  _loginRejected(code = 'INVALID_CREDENTIALS') {
    this._loginRetryDelay = Math.min(
      this._loginRetryDelay * 2 || SolarEdgeCloudClient.LOGIN_RETRY_MIN,
      SolarEdgeCloudClient.LOGIN_RETRY_MAX,
    );
    this._loginBlockedUntil = Date.now() + this._loginRetryDelay;
    this._loginBlockedCode = code;
    return codedError(LOGIN_ERRORS[code], code);
  }

  /**
   * Log in and keep the session cookies. A good login answers 302 (redirect to the portal). A
   * server error or rate limit holds back automatic logins as rejected credentials do, but as
   * LOGIN_REFUSED: a locked account answered 500, then 401 (live, 2026-10-16), and logging in on
   * makes a lockout last. A 302 is not proof: a session whose first answer is 401 counts as a
   * rejected login too (_request).
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

    // the status makes it an outage too (isOutage), which pauses the account's ticks
    if (res.status >= 500 || res.status === 429) {
      throw Object.assign(this._loginRejected('LOGIN_REFUSED'), { status: res.status });
    }

    if (res.status !== 302) throw this._loginRejected();

    // the retry delay is reset once the session answers (_request), not here
    this._loginBlockedUntil = 0;
    this.cookies = res.headers.getSetCookie().map((cookie) => cookie.split(';')[0]);
    // the redirect of a good login has not been recorded yet: logged for diagnostics reports
    this.log(`login redirects to ${new URL(res.headers.get('location') ?? '', BASE_URL).pathname}`);
  }

  /**
   * Log in when there is no session; concurrent callers share one login. After a login that was
   * not accepted this throws its error without a login until the retry delay has passed; an
   * explicit login() (settings, pairing) is not held back.
   */
  async ensureLoggedIn() {
    if (this.isLoggedIn()) return;
    if (Date.now() < this._loginBlockedUntil) {
      throw codedError(LOGIN_ERRORS[this._loginBlockedCode], this._loginBlockedCode);
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
      this._lastSuccessAt = Date.now();
      return result;
    } catch (error) {
      if (isOutage(error)) this._noteOutage(error);
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
      if (this.cookies === cookies) {
        this.cookies = [];
        // no answer yet on this session: the login was not accepted, else it logs in every poll
        if (this._confirmedCookies !== cookies) throw this._loginRejected();
      }
      if (!isRetry) {
        return this._request({
          url, method, body, errorText,
        }, true);
      }
      throw codedError('Unauthorized', 'UNAUTHORIZED');
    }

    if (res.ok && this.cookies === cookies && this._confirmedCookies !== cookies) {
      this._confirmedCookies = cookies;
      this._loginRetryDelay = 0;
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

  /*
  Endpoints below were found in other projects (zzz_docs/solaredge-cloud-api.md). The GETs and the
  optimizer POST answered live on 2026-10-15 on a site with only an inverter and optimizers, so
  battery, meter and smart-device payloads have only been seen empty. Dates are 'YYYY-MM-DD'
  unless stated otherwise.
  */

  /** Battery mode and TOU schedule; all null on a site without a battery. */
  async getSiteBatteryMode({ siteId }) {
    return this.request({
      url: `${HOME_AUTOMATION_URL}/storage/${siteId}/batteryMode`,
      errorText: 'Error Getting Site Battery Mode',
    });
  }

  /**
   * Not tested live. Replaces the whole battery mode and TOU schedule, e.g.
   * { batteryMode: 'MSC' } or 'MANUAL_TOU' with manualTouConfiguration (nerd2/solaredgego).
   * The answer carries status/httpStatus/errorMessages, also when it failed.
   */
  async setSiteBatteryMode({ siteId, mode }) {
    return this.request({
      url: `${HOME_AUTOMATION_URL}/storage/${siteId}/batteryMode`,
      method: 'PUT',
      body: mode,
      errorText: 'Error Setting Site Battery Mode',
    });
  }

  /** Batteries under devicesByType.BATTERY. */
  async getSiteBatteries({ siteId }) {
    return this.request({
      url: `${HOME_AUTOMATION_URL}/storage/${siteId}/getBatteries?triggerHF=false`,
      errorText: 'Error Getting Site Batteries',
    });
  }

  async getSiteExcessPvPriorities({ siteId }) {
    return this.request({
      url: `${HOME_AUTOMATION_URL}/sites/${siteId}/excessPvPrioritiesV2`,
      errorText: 'Error Getting Site Excess PV Priorities',
    });
  }

  /** Load devices (e.g. hot water controller); 404 'Unknown site id' on a site without any. */
  async getSiteLoadDevicesInfo({ siteId }) {
    return this.request({
      url: `${BASE_URL}/services/m/so/devices-list/site/${siteId}/info`,
      errorText: 'Error Getting Site Load Devices Info',
    });
  }

  async getSiteLoadDevicesState({ siteId }) {
    return this.request({
      url: `${BASE_URL}/services/m/so/devices-list/site/${siteId}/state`,
      errorText: 'Error Getting Site Load Devices State',
    });
  }

  /** Not tested live with a real device; an unknown id answers 404 'Unknown device id'. */
  async getSiteLoadDeviceInfo({ siteId, deviceId }) {
    return this.request({
      url: `${BASE_URL}/services/m/so/load-device/site/${siteId}/device/${deviceId}/info`,
      errorText: 'Error Getting Site Load Device Info',
    });
  }

  /** Not tested live with a real device; an unknown id answers 404 'Unknown device id'. */
  async getSiteLoadDeviceState({ siteId, deviceId }) {
    return this.request({
      url: `${BASE_URL}/services/m/so/load-device/site/${siteId}/device/${deviceId}/state`,
      errorText: 'Error Getting Site Load Device State',
    });
  }

  /** Equipment tree: inverters, strings and optimizers with their serials. */
  async getSiteLayout({ siteId }) {
    return this.request({
      url: `${LAYOUT_URL}/logical/generic/v2/site/${siteId}?include-optimizers=true`,
      errorText: 'Error Getting Site Layout',
    });
  }

  /** peakPower, installationDate, siteTimeZone, latitude/longitude. */
  async getSiteInformation({ siteId }) {
    return this.request({
      url: `${LAYOUT_URL}/information/site/${siteId}`,
      errorText: 'Error Getting Site Information',
    });
  }

  /**
   * Live readings and model per optimizer. Takes the full serials ('1245D625-52', as in
   * getSiteEnergyByInverter); the short ones of the layout answer 404 NOT_FOUND.
   */
  async getOptimizersInformation({ serials }) {
    return this.request({
      url: `${LAYOUT_URL}/information/optimizers`,
      method: 'POST',
      body: serials,
      errorText: 'Error Getting Optimizers Information',
    });
  }

  /** Live readings and firmware per inverter. */
  async getInvertersInformation({ serials }) {
    return this.request({
      url: withQuery(`${LAYOUT_URL}/information/inverters`, { 'inverter-serials': serials }),
      errorText: 'Error Getting Inverters Information',
    });
  }

  /** Measured production in Wh over the range; from installation on it is the lifetime total. */
  async getSiteEnergyTotal({ siteId, startDate, endDate }) {
    return this.request({
      url: withQuery(`${LAYOUT_URL}/energy/site/${siteId}`, { 'start-date': startDate, 'end-date': endDate }),
      errorText: 'Error Getting Site Energy Total',
    });
  }

  /** Energy per inverter, string and optimizer over the range, optionally with max temperature. */
  async getSiteEnergyByInverter({
    siteId, startDate, endDate, inverterSerials, includeMaxTemperature = false,
  }) {
    return this.request({
      url: withQuery(`${LAYOUT_URL}/energy/site/${siteId}/by-inverter`, {
        'start-date': startDate,
        'end-date': endDate,
        'inverter-serials': inverterSerials,
        'include-max-temperature': includeMaxTemperature,
        'include-color': true,
      }),
      errorText: 'Error Getting Site Energy By Inverter',
    });
  }

  /** Production per slot; timeUnit hours, days, months or years. */
  async getSiteEnergyGraph({
    siteId, timeUnit = 'days', startDate, endDate,
  }) {
    return this.request({
      url: withQuery(`${LAYOUT_URL}/energy-graph/site/${siteId}`, {
        'chart-time-unit': timeUnit, 'start-date': startDate, 'end-date': endDate,
      }),
      errorText: 'Error Getting Site Energy Graph',
    });
  }

  /** Production per slot of the given optimizers, summed into one series. */
  async getOptimizersEnergyGraph({
    siteId, optimizerSerials, timeUnit = 'days', startDate, endDate,
  }) {
    return this.request({
      url: withQuery(`${LAYOUT_URL}/energy-graph/site/${siteId}/optimizers`, {
        'chart-time-unit': timeUnit,
        'start-date': startDate,
        'end-date': endDate,
        'optimizer-serials': optimizerSerials,
      }),
      errorText: 'Error Getting Optimizers Energy Graph',
    });
  }

  /** Site power per slot; resolution hours or quarter-hours. */
  async getSitePowerPlayback({
    siteId, resolution = 'hours', startDate, endDate,
  }) {
    return this.request({
      url: withQuery(`${LAYOUT_URL}/playback/site/${siteId}`, {
        resolution, 'start-date': startDate, 'end-date': endDate,
      }),
      errorText: 'Error Getting Site Power Playback',
    });
  }

  /**
   * Hourly power per optimizer, at most 8 days. Dates are UTC 'YYYY-MM-DDTHH:mm:ssZ'. compact
   * packs the values into one array (compressData); otherwise one list per optimizer.
   */
  async getOptimizersPowerPlayback({
    siteId, startDate, endDate, compact = false,
  }) {
    return this.request({
      url: withQuery(`${LAYOUT_URL}/playback/site/${siteId}/${compact ? 'optimizers-compact' : 'optimizers'}`, {
        resolution: 'hours', 'start-date': startDate, 'end-date': endDate,
      }),
      errorText: 'Error Getting Optimizers Power Playback',
    });
  }

  /** currentAcPower and maxAcPower in W. */
  async getSiteLivePower({ siteId }) {
    return this.request({
      url: `${DASHBOARD_URL}/live-power/sites/${siteId}`,
      errorText: 'Error Getting Site Live Power',
    });
  }

  /** The web portal's power flow, in kW; the app's is getSitePowerflow. */
  async getSiteDashboardPowerFlow({ siteId }) {
    return this.request({
      url: `${DASHBOARD_URL}/power-flow/v2/sites/${siteId}`,
      errorText: 'Error Getting Site Dashboard Power Flow',
    });
  }

  /**
   * Power in W per slot (timeUnit quarter-hours or hours), with production, consumption,
   * import and export. measurementTypes is required (400 without); for the distribution legs
   * add e.g. 'production-distribution-without-storage' ('-with-storage' on a battery site).
   */
  async getSitePowerChart({
    siteId, timeUnit = 'hours', startDate, endDate,
    measurementTypes = ['production', 'consumption', 'import', 'export'],
  }) {
    return this.request({
      url: withQuery(`${DASHBOARD_URL}/power/sites/${siteId}`, {
        'chart-time-unit': timeUnit,
        'start-date': startDate,
        'end-date': endDate,
        'measurement-types': measurementTypes,
      }),
      errorText: 'Error Getting Site Power Chart',
    });
  }

  /**
   * Energy in Wh per slot (timeUnit days, months or years) and a summary over the whole range,
   * with import and export. Over years from installation on, the summary is a lifetime total;
   * import/export only seen as null (site without a meter). measurementTypes as for
   * getSitePowerChart.
   */
  async getSiteEnergyChart({
    siteId, timeUnit = 'days', startDate, endDate,
    measurementTypes = ['production', 'consumption', 'import', 'export'],
  }) {
    return this.request({
      url: withQuery(`${DASHBOARD_URL}/energy/sites/${siteId}`, {
        'chart-time-unit': timeUnit,
        'start-date': startDate,
        'end-date': endDate,
        'measurement-types': measurementTypes,
      }),
      errorText: 'Error Getting Site Energy Chart',
    });
  }

  async getInvertersEnergy({ siteId, startDate, endDate }) {
    return this.request({
      url: withQuery(`${DASHBOARD_URL}/inverters/energy/sites/${siteId}`, {
        'start-date': startDate, 'end-date': endDate, normalized: false, 'page-number': 0,
      }),
      errorText: 'Error Getting Inverters Energy',
    });
  }

  /** Power per inverter per slot; timeUnit quarter-hours or hours. */
  async getInvertersPower({
    siteId, timeUnit = 'hours', startDate, endDate,
  }) {
    return this.request({
      url: withQuery(`${DASHBOARD_URL}/inverters/power/sites/${siteId}`, {
        'start-date': startDate,
        'end-date': endDate,
        normalized: false,
        'chart-time-unit': timeUnit,
        'page-number': 0,
      }),
      errorText: 'Error Getting Inverters Power',
    });
  }

  /** Where the battery energy came from and went to; zeros on a site without a battery. */
  async getSiteStorageDistribution({
    siteId, timeUnit = 'days', startDate, endDate,
  }) {
    return this.request({
      url: withQuery(`${DASHBOARD_URL}/storage/energy/distribution/sites/${siteId}`, {
        'chart-time-unit': timeUnit, 'start-date': startDate, 'end-date': endDate,
      }),
      errorText: 'Error Getting Site Storage Distribution',
    });
  }

  /** Production per year, or per month/quarter across the years; period monthly, quarterly or yearly. */
  async getSiteComparativeEnergy({ siteId, period = 'yearly' }) {
    return this.request({
      url: `${DASHBOARD_URL}/comparative-energy/${siteId}/${period}`,
      errorText: 'Error Getting Site Comparative Energy',
    });
  }

  async getSiteDetails({ siteId }) {
    return this.request({
      url: `${DASHBOARD_URL}/site-details/${siteId}/details`,
      errorText: 'Error Getting Site Details',
    });
  }

  /** What the site has: hasStorage, hasConsumptionAndGrid, hasSmartDevices, hasEVChargers, ... */
  async getSiteComponents({ siteId }) {
    return this.request({
      url: `${DASHBOARD_URL}/site-details/${siteId}/components`,
      errorText: 'Error Getting Site Components',
    });
  }

  /** connectivityStatus (e.g. ONLINE) and active. */
  async getSiteCommunication({ siteId }) {
    return this.request({
      url: `${DASHBOARD_URL}/site-details/${siteId}/communication`,
      errorText: 'Error Getting Site Communication',
    });
  }

  /** Models and serials per kind: inverters, optimizers, storage, meters, evChargers, ... */
  async getSiteEquipment({ siteId }) {
    return this.request({
      url: `${DASHBOARD_URL}/v2/site-details/${siteId}/equipment`,
      errorText: 'Error Getting Site Equipment',
    });
  }

  /** productionDataAvailableFrom, consumptionDataAvailableFrom, lastUpdateTime. */
  async getSiteDataAvailability({ siteId }) {
    return this.request({
      url: `${DASHBOARD_URL}/data-availability/sites/${siteId}`,
      errorText: 'Error Getting Site Data Availability',
    });
  }

  /** Live weather, 5-day forecast, sunrise and sunset. */
  async getSiteWeather({ siteId }) {
    return this.request({
      url: `${DASHBOARD_URL}/weather/sites/${siteId}/weather`,
      errorText: 'Error Getting Site Weather',
    });
  }

  async getSiteAlerts({ siteId }) {
    return this.request({
      url: `${DASHBOARD_URL}/alerts/sites/${siteId}`,
      errorText: 'Error Getting Site Alerts',
    });
  }

  async getSiteEnvironmentalBenefits({ siteId }) {
    return this.request({
      url: `${DASHBOARD_URL}/environmental-benefits/sites/${siteId}`,
      errorText: 'Error Getting Site Environmental Benefits',
    });
  }

};
