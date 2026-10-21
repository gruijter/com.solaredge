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

const CommonDevice = require('../../lib/common_device');
const finite = require('../../lib/finite');
const { isAsleep } = require('../../lib/inverterSleep');

// energyOverview time period -> capability (energy in Wh)
const ENERGY_CAPABILITIES = {
  LIFE_TIME: 'meter_power',
  LAST_YEAR: 'meter_power.year',
  LAST_MONTH: 'meter_power.month',
  LAST_DAY: 'meter_power.day',
};

const PHASES = [1, 2, 3];

const round = (value, decimals) => (value === null ? null : Number(value.toFixed(decimals)));

/** The sum of `key` over `items`, or null when one of them has no number. */
const sum = (items, key) => {
  const values = items.map((item) => finite(item[key]));
  return values.includes(null) ? null : values.reduce((total, value) => total + value, 0);
};

/** { temperature, temperatureUnit } in °C; FAHRENHEIT converted, as Solarlibs/solaredge-web does. */
const celsius = (reading) => {
  const value = finite(reading?.temperature);
  if (value === null) return null;
  return String(reading.temperatureUnit || 'CELSIUS').toUpperCase() === 'FAHRENHEIT' ? round(((value - 32) * 5) / 9, 1) : value;
};

/** Today in `timeZone` as YYYY-MM-DD. */
const dateIn = (date, timeZone) => new Intl.DateTimeFormat('en-CA', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);

/** The serials of the site's inverters, from getSiteEquipment. */
const serialsOf = (equipment) => (equipment?.inverters?.details || []).flatMap((detail) => detail.serialNumbers || []);

/** The entries of a { serial: value } map that belong to `serials`. */
const pick = (bySerial, serials) => Object.entries(bySerial || {})
  .filter(([serial]) => serials.includes(serial))
  .map(([, value]) => value);

/** The sum of the optimizers' energy (DC, Wh) of an inverter in getSiteEnergyByInverter. */
const dcEnergy = (inverter) => (inverter.optimizers || []).reduce((total, optimizer) => total + (finite(optimizer.energy?.value) ?? 0), 0);

/**
 * The part of the site's production that is `serial`'s, from getSiteEnergyByInverter over the
 * same period. Without a battery the inverters' AC energy adds up to the site's production (seen
 * live: 15966 + 11743 = 27709 Wh); with a DC-coupled battery it holds battery energy too, so then
 * the optimizers' DC energy is used. `strings` is not: it can miss part of the energy (lifetime,
 * seen live). Shared evenly when there is no energy at all.
 * @returns {number|null} null when the inverter is not in the answer
 */
const shareOf = (byInverter, serial, { storage }) => {
  const inverters = byInverter?.inverters || [];
  if (!inverters.some((inverter) => inverter.serial === serial)) return null;
  const energyOf = (inverter) => (storage ? dcEnergy(inverter) : (finite(inverter.energy?.value) ?? 0));
  const total = inverters.reduce((sum, inverter) => sum + energyOf(inverter), 0);
  if (total <= 0) return 1 / inverters.length;
  return energyOf(inverters.find((inverter) => inverter.serial === serial)) / total;
};

/**
 * Battery power in W per inverter serial prefix, charging positive, from getSiteBatteries: a
 * POLESTAR (the inverter, info.serialNumber without the '-XX' suffix) lists its batteries in
 * connectedDevices. A battery's chargeEnergy/dischargeEnergy are its power in W, not energy (seen
 * live: dischargeEnergy -944 at storagePower -940 W, both 0 in STANDBY); batteryState gives the sign.
 */
const batteryPowerByInverter = (response) => {
  const batteries = response?.devicesByType?.BATTERY || [];
  const result = {};
  for (const inverter of response?.devicesByType?.POLESTAR || []) {
    const connected = inverter.connectedDevices || [];
    result[inverter.info?.serialNumber] = batteries
      .filter((battery) => connected.includes(battery.info?.deviceId))
      .reduce((total, battery) => {
        const watts = Math.abs(finite(battery.dischargeEnergy) || finite(battery.chargeEnergy) || 0);
        if (/^DISCHARG/i.test(battery.batteryState)) return total - watts;
        if (/^CHARG/i.test(battery.batteryState)) return total + watts;
        return total;
      }, 0);
  }
  return result;
};

/**
 * The part of the site's PV power that is `serial`'s, from each inverter's AC power. With a
 * DC-coupled battery that AC power holds the battery's too: PV is AC plus what the battery takes
 * (seen live: 1450 W AC - 944 W discharging = 506 W, powerflow PV 510 W). Null without PV power.
 */
const livePvShare = (information, serial, batteryPower = {}) => {
  const pv = Object.entries(information?.serialToLiveData || {}).map(([inverter, data]) => {
    const battery = Object.entries(batteryPower).find(([prefix]) => prefix && inverter.startsWith(prefix))?.[1] ?? 0;
    return [inverter, Math.max(0, (finite(data.pAc_W) ?? 0) + battery)];
  });
  const total = pv.reduce((sum, [, watts]) => sum + watts, 0);
  if (total <= 0 || !pv.some(([inverter]) => inverter === serial)) return null;
  return pv.find(([inverter]) => inverter === serial)[1] / total;
};

// inverterStatus -> inverter_status where the names differ ('production-limit' seen live, with
// powerLimit_percent below 100)
const STATUS_ALIASES = { 'production-limit': 'throttled' };

/** The status of several inverters: a fault first, then production, else the first known one. */
const statusOf = (reported, statuses) => {
  const known = reported
    .map((status) => STATUS_ALIASES[status.toLowerCase()] ?? status.toLowerCase())
    .filter((status) => statuses.includes(status));
  return ['fault', 'production'].find((status) => known.includes(status)) || known[0] || null;
};

/**
 * Voltage per phase (averaged over `serials`) and status, from getInvertersInformation.
 * @param {object} information
 * @param {object} options
 * @param {string[]} options.serials the inverters of the device
 * @param {string[]} options.statuses the values of the inverter_status capability
 * @param {number} [options.cadenceMs] the account's upload interval (isAsleep)
 * @returns {{values: object, phases: object[], live: object[], reported: string[]}}
 */
const liveValues = (information, { serials, statuses, cadenceMs }) => {
  const values = {};

  // lineNumber_3ph 1-3; v_ac_V line to neutral
  const phases = pick(information?.serialToPhaseMeasurements, serials).flat();
  for (const phase of PHASES) {
    const lines = phases.filter((line) => line.lineNumber_3ph === phase);
    if (!lines.length) continue;
    const voltage = sum(lines, 'v_ac_V');
    values[`measure_voltage.${phase}`] = round(voltage === null ? null : voltage / lines.length, 1);
  }

  // 'production', 'production-limit' and 'setup' (an idle inverter next to a producing one) were
  // seen live; the others are assumed after the SunSpec states
  const live = pick(information?.serialToLiveData, serials);
  const reported = live.map((item) => item.inverterStatus).filter((status) => typeof status === 'string');
  // asleep for the night the inverter stops uploading, its last status still 'production' (Dijker)
  if (isAsleep(live, { cadenceMs })) values.inverter_status = 'sleeping';
  else if (reported.length) values.inverter_status = statusOf(reported, statuses);

  return {
    values, phases, live, reported,
  };
};

/** The highest temperature of the optimizers of `serials` over the date range, from getSiteEnergyByInverter; null when none. */
const maxTemperature = (byInverter, serials) => {
  const temperatures = (byInverter?.inverters || [])
    .filter((inverter) => !inverter.serial || serials.includes(inverter.serial))
    .flatMap((inverter) => inverter.optimizers || [])
    .map((optimizer) => celsius(optimizer.temperature))
    .filter((temperature) => temperature !== null);
  return temperatures.length ? Math.max(...temperatures) : null;
};

/** The values of the inverter_status capability (app.json): lower-case inverterStatus, plus 'sleeping'. */
const statusesOf = (homey) => homey.manifest.capabilities.inverter_status.values.map((value) => value.id);

// an inverter's part of the site's month, year and lifetime production is fetched again after this
const SHARE_REFRESH_TIME = 60 * 60 * 1000;

// energyOverview time period -> the start of its range for getSiteEnergyByInverter, from today
const PERIOD_STARTS = {
  LAST_MONTH: (today) => `${today.slice(0, 8)}01`,
  LAST_YEAR: (today) => `${today.slice(0, 5)}01-01`,
};

/**
 * An inverter of the site (data.serialNumber), or all of them (a device paired per site: data
 * without serialNumber). Per inverter, the site's PV power and production are split by its part
 * (livePvShare, shareOf): SolarEdge gives them only for the site.
 */
module.exports = class SolarEdgeInverterDevice extends CommonDevice {

  /** The serials of the site's inverters, from getSiteEquipment. */
  static serialsOf(equipment) {
    return serialsOf(equipment);
  }

  /** The inverter's serial; null for a device of the whole site. */
  get serial() {
    return this.getData().serialNumber ?? null;
  }

  async onPoll() {
    const { siteId } = this.getData();

    const sitePowerflow = await this.client.getSitePowerflow({ siteId });
    this.storage = sitePowerflow.storage?.isActive === true;

    // currentPower in kW
    if (typeof sitePowerflow.solarProduction?.currentPower === 'number') {
      this.sitePvPower = Math.round(sitePowerflow.solarProduction.currentPower * 1000);
      await this.updatePower();
    }

    if (sitePowerflow.solarProduction?.isActive) {
      await this.setAvailable();
    } else {
      await this.setUnavailable();
    }

    // optional readings: a failure leaves the device as it is
    if (this.energyDue()) {
      // updateSiteAlarms reuses the live data of updateInverterDetails
      this.live = null;
      this.dayAnswer = null;
      await this.updateEnergy(siteId).catch((error) => this.error(`Error Fetching Energy: ${error.message}`));
      await this.updateInverterDetails().catch((error) => this.error(`Error Fetching Inverter Details: ${error.message}`));
      await this.updateSiteAlarms().catch((error) => this.error(`Error Fetching Site Alarms: ${error.message}`));
    }
  }

  /** Whether the device has all of the site's production: a site device, or the site's only inverter. */
  async wholeSite() {
    return !this.serial || (await this.inverterSerials()).length <= 1;
  }

  /** The inverters of the device. */
  async ownSerials() {
    return this.serial ? [this.serial] : this.inverterSerials();
  }

  /** measure_power: the site's PV power, or this inverter's part once known. */
  async updatePower() {
    if (typeof this.sitePvPower !== 'number') return;
    const whole = await this.wholeSite().catch(() => null);
    const share = whole ? 1 : this.powerShare;
    if (whole === null || typeof share !== 'number') return;
    await this.setCapability('measure_power', Math.round(this.sitePvPower * share));
  }

  /**
   * Lifetime, year, month and day production; a period without a number is left as it is. An
   * inverter's lifetime part only rises: its share can shift a little between answers.
   */
  async updateEnergy(siteId) {
    const { energyProducedOverviewList } = await this.client.getSiteEnergyOverview({ siteId });
    const whole = await this.wholeSite();
    for (const { timePeriod, energy: value } of Object.values(energyProducedOverviewList || {})) {
      const capability = ENERGY_CAPABILITIES[timePeriod];
      if (!capability || typeof value !== 'number') continue;
      // a period whose share fails is left as it is; the others still update
      // eslint-disable-next-line no-await-in-loop
      const share = whole ? 1 : await this.energyShare(timePeriod).catch((error) => {
        this.error(`Error Fetching Energy Share ${timePeriod}: ${error.message}`);
        return null;
      });
      if (share === null) continue;
      let kwh = (value * share) / 1000;
      if (!whole && timePeriod === 'LIFE_TIME') {
        kwh = Math.max(kwh, this.getStoreValue('lifetimeKwh') ?? 0);
        // eslint-disable-next-line no-await-in-loop
        if (kwh !== this.getStoreValue('lifetimeKwh')) await this.setStoreValue('lifetimeKwh', kwh);
      }
      // eslint-disable-next-line no-await-in-loop
      await this.setCapability(capability, kwh);
    }
  }

  /** Today's getSiteEnergyByInverter of all the site's inverters, with temperatures; once per energy tick. */
  async dayByInverter() {
    if (!this.dayAnswer) {
      const today = await this.siteToday();
      this.dayAnswer = await this.client.getSiteEnergyByInverter({
        siteId: this.getData().siteId, startDate: today, endDate: today, inverterSerials: await this.inverterSerials(), includeMaxTemperature: true,
      });
    }
    return this.dayAnswer;
  }

  /** This inverter's part of the site's production over an energyOverview period (shareOf); null when unknown. */
  async energyShare(timePeriod) {
    if (timePeriod === 'LAST_DAY') return shareOf(await this.dayByInverter(), this.serial, { storage: this.storage });
    const cached = this.shares?.[timePeriod];
    if (cached && cached.storage === this.storage && Date.now() - cached.at < SHARE_REFRESH_TIME) return cached.value;

    const today = await this.siteToday();
    const startDate = PERIOD_STARTS[timePeriod]?.(today) ?? await this.siteStartDate();
    const value = shareOf(await this.client.getSiteEnergyByInverter({
      siteId: this.getData().siteId, startDate, endDate: today, inverterSerials: await this.inverterSerials(),
    }), this.serial, { storage: this.storage });
    this.shares = { ...this.shares, [timePeriod]: { value, storage: this.storage, at: Date.now() } };
    return value;
  }

  /** The serials of the site's inverters, from its equipment list; fetched once per app run. */
  async inverterSerials() {
    if (!this.serials?.length) {
      this.serials = serialsOf(await this.client.getSiteEquipment({ siteId: this.getData().siteId }));
    }
    return this.serials;
  }

  /** isAsleep at the account's upload interval. */
  asleep(live) {
    return isAsleep(live, { cadenceMs: this.homey.app?.uploadCadence?.(this.client) });
  }

  /**
   * Asleep for the night (lib/inverterSleep.js): an inverter stops uploading, and about an hour after
   * its last upload the site is no longer ONLINE (Dijker 2026-10-15: 0 W at 18:40, offline 20:02 to
   * 08:15). From this tick's live data, fetched again when updateInverterDetails failed. False when
   * unknown.
   */
  async offlineExpected() {
    try {
      if (this.live) return this.asleep(this.live);
      const serials = await this.inverterSerials();
      if (!serials.length) return false;
      return this.asleep(pick((await this.client.getInvertersInformation({ serials }))?.serialToLiveData, await this.ownSerials()));
    } catch (error) {
      this.error(`Error Fetching Inverter Sleep: ${error.message}`);
      return false;
    }
  }

  /**
   * Voltage per phase (averaged over the device's inverters), status, the hottest optimizer of
   * today and an inverter's part of the PV power. Inverter readings are refreshed every few minutes
   * (lastMeasurement, seen live).
   */
  async updateInverterDetails() {
    const { siteId } = this.getData();
    const serials = await this.inverterSerials();
    if (!serials.length) return;
    const own = await this.ownSerials();

    const information = await this.client.getInvertersInformation({ serials });
    const {
      values, phases, live, reported,
    } = liveValues(information, { serials: own, statuses: statusesOf(this.homey), cadenceMs: this.homey.app?.uploadCadence?.(this.client) });

    // the account's energy tick follows the inverters' measurement moments (app.js)
    for (const [serial, data] of Object.entries(information?.serialToLiveData || {})) {
      this.homey.app?.noteSnapshot?.(this.client, serial, Date.parse(data.lastMeasurement));
    }

    this.live = live;
    if (phases.length && !phases.some((line) => PHASES.includes(line.lineNumber_3ph))) {
      this.logOnce('phases', 'phase measurements without lineNumber_3ph 1-3:', JSON.stringify(phases));
    }
    reported.forEach((status) => this.logOnce(`status ${status}`, 'inverter status', status));

    // none yet today (before sunrise): cleared rather than yesterday's
    const day = await this.dayByInverter();
    values['measure_temperature.max'] = maxTemperature(day, own);

    if (!(await this.wholeSite())) {
      const batteryPower = this.storage
        ? batteryPowerByInverter(await this.client.getSiteBatteries({ siteId }).catch((error) => {
          this.error(`Error Fetching Batteries: ${error.message}`);
          return null;
        }))
        : {};
      this.powerShare = livePvShare(information, this.serial, batteryPower) ?? shareOf(day, this.serial, { storage: this.storage });
      await this.updatePower();
    }

    await this.recordSeenCaps(values);
    for (const [capability, value] of Object.entries(values)) {
      // an unknown status or no temperature yet is cleared rather than left stale
      if (value === null && !['inverter_status', 'measure_temperature.max'].includes(capability)) continue;
      // eslint-disable-next-line no-await-in-loop
      await this.setCapability(capability, value);
    }
  }

  /**
   * The readings of updateInverterDetails, for pairing (lib/common_driver.js): the same calls.
   * Before sunrise there is no temperature yet: it is added on the first poll that has one.
   */
  static async pairValues({
    client, site, homey, device,
  }) {
    const serials = serialsOf(await client.getSiteEquipment({ siteId: site.id }));
    if (!serials.length) return {};
    const own = device?.data?.serialNumber ? [device.data.serialNumber] : serials;
    const { values } = liveValues(await client.getInvertersInformation({ serials }), { serials: own, statuses: statusesOf(homey) });
    const today = dateIn(new Date(), site.timezone || homey.clock.getTimezone());
    values['measure_temperature.max'] = maxTemperature(await client.getSiteEnergyByInverter({
      siteId: site.id, startDate: today, endDate: today, inverterSerials: serials, includeMaxTemperature: true,
    }), own);
    return values;
  }

};
