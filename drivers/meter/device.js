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
const { FIRST_YEAR } = require('../../lib/solarEdgeConstants');

// a past year is stored only this long after it ended: then it has ended in every timezone and its
// last data is in (assumed)
const YEAR_SETTLE_TIME = 2 * 24 * 60 * 60 * 1000;
// a year without data, or without import/export, is asked again after this, in case that answer
// was a hiccup
const MISSING_RECHECK_TIME = 24 * 60 * 60 * 1000;

const isTotals = (value) => typeof value?.imported === 'number' && typeof value?.exported === 'number';

module.exports = class SolarEdgeMeterDevice extends CommonDevice {

  async onPoll() {
    const { siteId } = this.getData();

    const sitePowerflow = await this.client.getSitePowerflow({ siteId });

    // currentPower in kW, always positive; null when there is none

    // Grid: import positive
    if (typeof sitePowerflow.grid?.currentPower === 'number') {
      let power = Math.round(sitePowerflow.grid.currentPower * 1000);
      // status import/export (compared case-insensitively, as openHAB's solaredge binding does)
      if (String(sitePowerflow.grid?.status).toLowerCase() === 'export') power *= -1;
      await this.setCapability('measure_power', power);
      await this.setCapability('measure_power.grid', power);
    } else if (sitePowerflow.grid?.currentPower === null) {
      // no exchange with a meter, nothing known without one
      const power = sitePowerflow.grid.isActive ? 0 : null;
      await this.setCapability('measure_power', power);
      await this.setCapability('measure_power.grid', power);
    }

    if (sitePowerflow.consumption?.currentPower === null) {
      await this.setCapability('measure_power.load', 0);
    } else if (typeof sitePowerflow.consumption?.currentPower === 'number') {
      await this.setCapability('measure_power.load', Math.round(sitePowerflow.consumption.currentPower * 1000));
    }

    if (typeof sitePowerflow.solarProduction?.currentPower === 'number') {
      await this.setCapability('measure_power.solar', Math.round(sitePowerflow.solarProduction.currentPower * 1000));
    }

    if (sitePowerflow.consumption?.isActive) {
      await this.setAvailable();
    } else {
      await this.setUnavailable();
    }

    if (!this.energyDue()) return;

    await this.updateSiteAlarms().catch((error) => this.error(`Error Fetching Site Alarms: ${error.message}`));

    // the yearly totals take several calls: one run at a time, outside the poll
    if (!this.getTotalPromise) {
      this.getTotalPromise = this.updateTotals(siteId)
        .catch((error) => {
          this.error(`Error Fetching Totals: ${error.message}`);
        })
        .finally(() => {
          delete this.getTotalPromise;
        });
    }
  }

  /** The site's current and first year with data (installationDate, seen live), else FIRST_YEAR. */
  async siteYears() {
    const installed = await this.siteInstalled();
    return {
      currentYear: Number((await this.siteToday()).slice(0, 4)),
      firstYear: installed ? Number(installed.slice(0, 4)) : FIRST_YEAR,
    };
  }

  /**
   * Lifetime import/export as the sum of all yearly totals. Past years are kept in the store as
   * `measurements-<year>`: { imported, exported } in Wh (plus unknown, checkedAt when the answer had
   * no import/export: asked again daily), or { missing: true, checkedAt } when there is no data (the
   * site did not exist yet).
   */
  async updateTotals(siteId) {
    const measurements = {};
    const { currentYear, firstYear } = await this.siteYears();

    for (let year = currentYear - 1; year >= firstYear; year -= 1) {
      // eslint-disable-next-line no-await-in-loop
      measurements[year] = await this.pastYearTotals(siteId, year);
      if (measurements[year] === 'error') throw new Error(`Missing Data For Year ${year}`);
      if (measurements[year] === 'missing') break;
    }

    measurements[currentYear] = await this.yearTotals(siteId, currentYear);
    // the current year only grows: a null answer after real ones is a hiccup, not a meter removed
    const known = this.currentYearTotals;
    if (measurements[currentYear].unknown && known?.year === currentYear) measurements[currentYear] = known.totals;
    else if (!measurements[currentYear].unknown) this.currentYearTotals = { year: currentYear, totals: measurements[currentYear] };

    let totalImported = 0;
    let totalExported = 0;
    for (const year of Object.keys(measurements)) {
      if (measurements[year] === 'missing') continue;
      totalImported += measurements[year].imported;
      totalExported += measurements[year].exported;
    }

    // Wh -> kWh, unrounded; the manifest's 3 decimals keep Wh resolution
    await this.setCapability('meter_power.imported', totalImported / 1000);
    await this.setCapability('meter_power.exported', totalExported / 1000);
  }

  /**
   * A past year's totals, 'missing' or 'error': from the store, else fetched and, once the year has
   * settled, stored. Errors are not stored, so the next run asks again.
   */
  async pastYearTotals(siteId, year) {
    const key = `measurements-${year}`;
    const stored = this.getStoreValue(key);
    if (isTotals(stored) && !(stored.unknown && Date.now() - stored.checkedAt >= MISSING_RECHECK_TIME)) return stored;
    if (stored?.missing && Date.now() - stored.checkedAt < MISSING_RECHECK_TIME) return 'missing';

    this.log(`Fetching measurements for ${year}...`);
    await new Promise((resolve) => {
      this.homey.setTimeout(resolve, 1000); // Prevent Rate limit
    });

    let value;
    try {
      value = await this.yearTotals(siteId, year);
    } catch (err) {
      if (!err.message.includes('INVALID_ARGUMENTS') && !err.message.includes('empty_summary')) {
        this.error(`Error fetching measurements for ${year}: ${err.message}`);
        return 'error';
      }
      // with data for the year before, 'no data' cannot be the start of the site
      if (isTotals(this.getStoreValue(`measurements-${year - 1}`))) {
        this.error(`No data for ${year}, but there is for ${year - 1}`);
        return 'error';
      }
      this.log(`No more data for ${year}`);
      value = 'missing';
    }

    if (Date.now() >= Date.UTC(year + 1, 0, 1) + YEAR_SETTLE_TIME) {
      let stored = value;
      if (value === 'missing') stored = { missing: true, checkedAt: Date.now() };
      else if (value.unknown) stored = { ...value, checkedAt: Date.now() };
      await this.setStoreValue(key, stored);
    }
    return value;
  }

  /**
   * A year's import/export in Wh; throws INVALID_ARGUMENTS or empty_summary when it has no data
   * (a year before the site existed answers summary: null, seen live). Without a grid meter in that
   * year import/export are null: counted as 0, marked `unknown` (it can also be a hiccup).
   */
  async yearTotals(siteId, year) {
    const result = await this.client.getSiteMeasurements({ siteId, endDate: `${year}-12-31` });
    if (!result.summary) throw new Error('empty_summary');
    const { import: imported, export: exported } = result.summary;
    const totals = { imported: imported ?? 0, exported: exported ?? 0 };
    if (typeof imported !== 'number' || typeof exported !== 'number') totals.unknown = true;
    return totals;
  }

};
