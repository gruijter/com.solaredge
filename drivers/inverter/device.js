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

// energyOverview time period -> capability (energy in Wh)
const ENERGY_CAPABILITIES = {
  LIFE_TIME: 'meter_power',
  LAST_YEAR: 'meter_power.year',
  LAST_MONTH: 'meter_power.month',
  LAST_DAY: 'meter_power.day',
};

const PHASES = [1, 2, 3];

// added once getInvertersInformation / getSiteEnergyByInverter report a value. Last in the order,
// and the temperature (none before sunrise) last of them: a capability added in the middle makes
// DeviceMigrator remove and re-add every one after it.
const OPTIONAL_CAPABILITIES = [
  ...PHASES.map((phase) => `measure_voltage.${phase}`),
  ...PHASES.map((phase) => `measure_current.${phase}`),
  ...PHASES.map((phase) => `measure_power.${phase}`),
  'measure_voltage.dc',
  'inverter_status',
  'measure_temperature.max',
];

const CAPABILITY_ORDER = ['measure_power', 'meter_power', 'meter_power.day', 'meter_power.month', 'meter_power.year',
  'alarm_problem', 'alarm_connectivity', ...OPTIONAL_CAPABILITIES];

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
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

module.exports = class SolarEdgeInverterDevice extends CommonDevice {

  capabilityOrder() {
    return CAPABILITY_ORDER;
  }

  optionalCapabilities() {
    return OPTIONAL_CAPABILITIES;
  }

  async onPoll() {
    const { siteId } = this.getData();

    const sitePowerflow = await this.client.getSitePowerflow({ siteId });

    // currentPower in kW
    if (typeof sitePowerflow.solarProduction?.currentPower === 'number') {
      await this.setCapability('measure_power', Math.round(sitePowerflow.solarProduction.currentPower * 1000));
    }

    if (sitePowerflow.solarProduction?.isActive) {
      await this.setAvailable();
    } else {
      await this.setUnavailable();
    }

    // optional readings: a failure leaves the device as it is
    if (this.energyDue()) {
      await this.updateEnergy(siteId).catch((error) => this.error(`Error Fetching Energy: ${error.message}`));
      await this.updateInverterDetails().catch((error) => this.error(`Error Fetching Inverter Details: ${error.message}`));
      await this.updateSiteAlarms().catch((error) => this.error(`Error Fetching Site Alarms: ${error.message}`));
    }
  }

  /** Lifetime, year, month and day production; a period without a number is left as it is. */
  async updateEnergy(siteId) {
    const { energyProducedOverviewList } = await this.client.getSiteEnergyOverview({ siteId });
    for (const { timePeriod, energy: value } of Object.values(energyProducedOverviewList || {})) {
      const capability = ENERGY_CAPABILITIES[timePeriod];
      // eslint-disable-next-line no-await-in-loop
      if (capability && typeof value === 'number') await this.setCapability(capability, value / 1000);
    }
  }

  /** The translated text of an inverterStatus, else the status itself. */
  statusText(status) {
    const key = `inverterStatus.${status.toLowerCase()}`;
    const text = this.homey.__(key);
    return text && text !== key ? text : status;
  }

  /** The serials of the site's inverters, from its equipment list; fetched once per app run. */
  async inverterSerials() {
    if (!this.serials?.length) {
      const equipment = await this.client.getSiteEquipment({ siteId: this.getData().siteId });
      this.serials = (equipment?.inverters?.details || []).flatMap((detail) => detail.serialNumbers || []);
    }
    return this.serials;
  }

  /**
   * Per phase, DC voltage and the hottest optimizer of today. The site device covers all its
   * inverters: power and current are summed per phase, voltage averaged; DC voltage only with one
   * inverter. Inverter readings are refreshed every few minutes (lastMeasurement, seen live).
   */
  async updateInverterDetails() {
    const { siteId } = this.getData();
    const serials = await this.inverterSerials();
    if (!serials.length) return;

    const values = {};
    const information = await this.client.getInvertersInformation({ serials });

    // lineNumber_3ph 1-3; activePower_W, i_ac_A, v_ac_V (line to neutral)
    const phases = Object.values(information?.serialToPhaseMeasurements || {}).flat();
    for (const phase of PHASES) {
      const lines = phases.filter((line) => line.lineNumber_3ph === phase);
      if (!lines.length) continue;
      const voltage = sum(lines, 'v_ac_V');
      values[`measure_power.${phase}`] = round(sum(lines, 'activePower_W'), 0);
      values[`measure_current.${phase}`] = round(sum(lines, 'i_ac_A'), 2);
      values[`measure_voltage.${phase}`] = round(voltage === null ? null : voltage / lines.length, 1);
    }

    // the account's energy tick follows the inverters' measurement moments (app.js)
    for (const [serial, data] of Object.entries(information?.serialToLiveData || {})) {
      this.homey.app?.noteSnapshot?.(this.client, serial, Date.parse(data.lastMeasurement));
    }

    const live = Object.values(information?.serialToLiveData || {});
    if (live.length === 1) values['measure_voltage.dc'] = round(finite(live[0].vDc_V), 1);
    if (phases.length && !phases.some((line) => PHASES.includes(line.lineNumber_3ph))) {
      this.logOnce('phases', 'phase measurements without lineNumber_3ph 1-3:', JSON.stringify(phases));
    }

    // only 'production' was seen live; the others are assumed after the SunSpec states (fault first)
    const statuses = live.map((item) => item.inverterStatus).filter((status) => typeof status === 'string');
    statuses.forEach((status) => this.logOnce(`status ${status}`, 'inverter status', status));
    const status = statuses.find((item) => item.toLowerCase() === 'fault') || statuses[0];
    if (status) values.inverter_status = this.statusText(status);

    // the highest temperature of each optimizer over the date range
    const today = dateIn(new Date(), await this.siteTimeZone());
    const byInverter = await this.client.getSiteEnergyByInverter({
      siteId, startDate: today, endDate: today, inverterSerials: serials, includeMaxTemperature: true,
    });
    const temperatures = (byInverter?.inverters || [])
      .flatMap((inverter) => inverter.optimizers || [])
      .map((optimizer) => celsius(optimizer.temperature))
      .filter((temperature) => temperature !== null);
    // none yet today (before sunrise): cleared rather than yesterday's
    values['measure_temperature.max'] = temperatures.length ? Math.max(...temperatures) : null;

    await this.recordSeenCaps(values);
    for (const [capability, value] of Object.entries(values)) {
      if (value === null && capability !== 'measure_temperature.max') continue;
      // eslint-disable-next-line no-await-in-loop
      await this.setCapability(capability, value);
    }
  }

};
