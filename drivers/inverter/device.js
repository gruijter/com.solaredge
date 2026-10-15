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

module.exports = class SolarEdgeInverterDevice extends CommonDevice {

  async onPoll() {
    const { siteId } = this.getData();

    const sitePowerflow = await this.client.getSitePowerflow({ siteId });

    // currentPower in kW
    if (typeof sitePowerflow.solarProduction?.currentPower === 'number') {
      await this.setCapability('measure_power', Math.round(sitePowerflow.solarProduction.currentPower * 1000));
    }

    const { energyProducedOverviewList } = await this.client.getSiteEnergyOverview({ siteId });

    for (const { timePeriod, energy } of Object.values(energyProducedOverviewList)) {
      const capability = ENERGY_CAPABILITIES[timePeriod];
      // eslint-disable-next-line no-await-in-loop
      if (capability) await this.setCapability(capability, energy / 1000);
    }

    if (sitePowerflow.solarProduction?.isActive) {
      await this.setAvailable();
    } else {
      await this.setUnavailable();
    }
  }

};
