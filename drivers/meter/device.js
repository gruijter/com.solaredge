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

module.exports = class SolarEdgeMeterDevice extends CommonDevice {

  async onPoll() {
    const { siteId } = this.getData();

    const sitePowerflow = await this.client.getSitePowerflow({ siteId });

    // Consumption; currentPower in kW, null when there is none
    if (sitePowerflow.consumption?.currentPower === null) {
      await this.setCapability('measure_power', 0);
    } else if (typeof sitePowerflow.consumption?.currentPower === 'number') {
      await this.setCapability('measure_power', Math.round(sitePowerflow.consumption.currentPower * 1000));
    }

    // Grid: import positive
    if (typeof sitePowerflow.grid?.currentPower === 'number') {
      if (!this.hasCapability('measure_power.grid')) {
        await this.addCapability('measure_power.grid');
      }

      let power = Math.round(sitePowerflow.grid.currentPower * 1000);
      if (sitePowerflow.grid?.status === 'export') power *= -1;
      await this.setCapability('measure_power.grid', power);
    }

    // Solar
    if (typeof sitePowerflow.solarProduction?.currentPower === 'number') {
      if (!this.hasCapability('measure_power.solar')) {
        await this.addCapability('measure_power.solar');
      }

      let power = Math.round(sitePowerflow.solarProduction.currentPower * 1000);
      if (sitePowerflow.solarProduction?.isProducing === false) power *= -1;
      await this.setCapability('measure_power.solar', power);
    }

    if (sitePowerflow.consumption?.isActive) {
      await this.setAvailable();
    } else {
      await this.setUnavailable();
    }

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

  /**
   * Lifetime import/export as the sum of all yearly totals. Past years are kept in the store as
   * `measurements-<year>`: { imported, exported } in Wh, 'missing' (no data: the site did not exist
   * yet) or 'error' (retried on the next run).
   */
  async updateTotals(siteId) {
    const measurements = {};
    const currentYear = new Date().getFullYear();

    for (let year = currentYear - 1; ; year -= 1) {
      // eslint-disable-next-line no-await-in-loop
      measurements[year] = await this.pastYearTotals(siteId, year);
      // An error year fails this run anyway (below), so stop here: walking on to older years
      // never ends while every request fails.
      if (measurements[year] === 'missing' || measurements[year] === 'error') break;
    }

    measurements[currentYear] = await this.client.getSiteMeasurements({
      siteId,
      endDate: `${currentYear}-12-31`,
    }).then((result) => ({
      imported: result.summary.import,
      exported: result.summary.export,
    }));

    let totalImported = 0;
    let totalExported = 0;
    for (const year of Object.keys(measurements)) {
      if (measurements[year] === 'missing') continue;
      if (measurements[year] === 'error') throw new Error(`Missing Data For Year ${year}`);
      totalImported += measurements[year].imported;
      totalExported += measurements[year].exported;
    }

    // Wh -> kWh
    await this.setCapability('meter_power.imported', Math.round(totalImported / 1000));
    await this.setCapability('meter_power.exported', Math.round(totalExported / 1000));
  }

  /** A past year's totals: from the store, else fetched and stored. */
  async pastYearTotals(siteId, year) {
    const key = `measurements-${year}`;
    const stored = this.getStoreValue(key);
    if (stored !== null && stored !== undefined && stored !== 'error') return stored;

    this.log(`Fetching measurements for ${year}...`);
    await new Promise((resolve) => {
      this.homey.setTimeout(resolve, 1000); // Prevent Rate limit
    });

    let value;
    try {
      const result = await this.client.getSiteMeasurements({ siteId, endDate: `${year}-12-31` });
      if (!result.summary) throw new Error('empty_summary');
      value = {
        imported: result.summary.import,
        exported: result.summary.export,
      };
    } catch (err) {
      if (err.message.includes('INVALID_ARGUMENTS') || err.message.includes('empty_summary')) {
        this.log(`No more data for ${year}`);
        value = 'missing';
      } else {
        this.error(`Error fetching measurements for ${year}: ${err.message}`);
        value = 'error';
      }
    }
    await this.setStoreValue(key, value);
    return value;
  }

};
