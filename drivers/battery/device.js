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

const CHARGING_STATES = ['charging', 'discharging', 'idle'];

/** The sum of `key` over the batteries, or null when one of them has no number. */
const sum = (batteries, key) => {
  const values = batteries.map((battery) => battery[key]);
  if (!values.length || values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) return null;
  return values.reduce((total, value) => total + value, 0);
};

/** kWh per unit of the battery energies: kWh below a nameplate of 100, else Wh; null without a nameplate. */
const unitOf = (namePlate) => {
  if (namePlate === null || namePlate <= 0) return null;
  return namePlate < 100 ? 1 : 1 / 1000;
};

/**
 * Energies (kWh) and health of the batteries; charged and discharged as reported, without monotonic().
 * @param {object[]} batteries
 * @param {number} toKwh
 */
const readings = (batteries, toKwh) => {
  const kwh = (key) => {
    const value = sum(batteries, key);
    return value === null ? null : value * toKwh;
  };
  const namePlate = sum(batteries, 'namePlateEnergy');
  const fullPack = kwh('fullPackEnergy');
  return {
    'meter_power.charged': kwh('chargeEnergy'),
    'meter_power.discharged': kwh('dischargeEnergy'),
    measure_residual_energy: kwh('remainingEnergy'),
    measure_soh: fullPack !== null && namePlate > 0 ? Math.min(100, Math.round((fullPack / (namePlate * toKwh)) * 100)) : null,
  };
};

module.exports = class SolarEdgeBatteryDevice extends CommonDevice {

  async onPoll() {
    const sitePowerflow = await this.client.getSitePowerflow({ siteId: this.getData().siteId });
    const { storage } = sitePowerflow;
    // charging/discharging/idle, compared case-insensitively (as openHAB's solaredge binding)
    const status = typeof storage?.status === 'string' ? storage.status.toLowerCase() : storage?.status;

    // currentPower in kW, always positive: negative while discharging; null when there is none
    if (typeof storage?.currentPower === 'number') {
      let power = Math.round(storage.currentPower * 1000);
      if (status === 'discharging') power *= -1;
      await this.setCapability('measure_power', power);
    } else if (storage?.currentPower === null) {
      await this.setCapability('measure_power', storage.isActive ? 0 : null);
    }

    if (typeof storage?.chargeLevel === 'number') {
      await this.setCapability('measure_battery', storage.chargeLevel);
    }

    if (CHARGING_STATES.includes(status)) {
      await this.setCapability('battery_charging_state', status);
    } else if (storage?.status) {
      this.logOnce(`status ${storage.status}`, 'unknown storage status', storage.status);
    }

    if (storage?.isActive) {
      await this.setAvailable();
    } else {
      await this.setUnavailable();
    }

    if (this.energyDue()) {
      await this.updateBatteries().catch((error) => this.error(`Error Fetching Batteries: ${error.message}`));
      await this.updateSiteAlarms().catch((error) => this.error(`Error Fetching Site Alarms: ${error.message}`));
    }
  }

  /**
   * Energy, remaining energy and health of the site's batteries (getSiteBatteries, summed). Not
   * seen live: the fields are from nerd2/solaredgego. Energies are taken as Wh, as in the other
   * home-automation answers (EV sessionEnergy Wh, ratedPower W: briadelour example_raw_json),
   * unless the nameplate is below 100, which can only be kWh. chargeEnergy/dischargeEnergy may be
   * lifetime or periodic counters: monotonic() keeps the Energy meters rising either way. The raw
   * values are logged once per app run to check this in diagnostics reports.
   */
  async updateBatteries() {
    const response = await this.client.getSiteBatteries({ siteId: this.getData().siteId });
    const batteries = response?.devicesByType?.BATTERY || [];
    if (!batteries.length) {
      this.logOnce('no batteries', 'getSiteBatteries lists no BATTERY:', JSON.stringify(response?.devicesByType));
      return;
    }
    batteries.forEach((battery) => {
      this.logOnce(`battery ${battery.info?.serialNumber}`, 'battery', JSON.stringify({
        batteryState: battery.batteryState,
        chargeEnergy: battery.chargeEnergy,
        dischargeEnergy: battery.dischargeEnergy,
        remainingEnergy: battery.remainingEnergy,
        fullPackEnergy: battery.fullPackEnergy,
        namePlateEnergy: battery.namePlateEnergy,
        communicationStatus: battery.communicationStatus,
        model: battery.info?.model,
      }));
    });

    // the unit is kept from the last answer with a nameplate: a guess that flips between answers
    // would change the counters 1000-fold
    const namePlate = sum(batteries, 'namePlateEnergy');
    let toKwh = this.getStoreValue('energyToKwh') ?? 1 / 1000;
    const unit = unitOf(namePlate);
    if (unit !== null) {
      if (unit !== toKwh) await this.setStoreValue('energyToKwh', unit);
      toKwh = unit;
    }
    this.logOnce(`unit ${toKwh}`, `battery energies taken as ${toKwh === 1 ? 'kWh' : 'Wh'} (nameplate ${namePlate})`);

    const values = readings(batteries, toKwh);
    // monotonic() on the raw counters: a unit corrected later then rescales them, instead of
    // leaving an offset in the wrong unit
    for (const [capability, name, key] of [
      ['meter_power.charged', 'chargedRaw', 'chargeEnergy'],
      ['meter_power.discharged', 'dischargedRaw', 'dischargeEnergy'],
    ]) {
      const raw = sum(batteries, key);
      // eslint-disable-next-line no-await-in-loop
      if (raw !== null) values[capability] = Math.round((await this.monotonic(name, raw)) * toKwh * 1000) / 1000;
    }

    await this.recordSeenCaps(values);
    for (const [capability, value] of Object.entries(values)) {
      // eslint-disable-next-line no-await-in-loop
      if (value !== null) await this.setCapability(capability, value);
    }
  }

  /** The readings of updateBatteries, for pairing (lib/common_driver.js): the same call. */
  static async pairValues({ client, site }) {
    const batteries = (await client.getSiteBatteries({ siteId: site.id }))?.devicesByType?.BATTERY || [];
    return batteries.length ? readings(batteries, unitOf(sum(batteries, 'namePlateEnergy')) ?? 1 / 1000) : {};
  }

};
