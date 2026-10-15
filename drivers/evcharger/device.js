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

// powerflow evCharger.connectionStatus -> [evcharger_charging_state, evcharger_charging]
const CONNECTION_STATES = {
  connected: ['plugged_in', false],
  charging: ['plugged_in_charging', true],
  disconnected: ['plugged_out', false],
};

module.exports = class SolarEdgeEVChargerDevice extends CommonDevice {

  async onInit() {
    await super.onInit();

    this.registerCapabilityListener('evcharger_charging', async (value) => {
      await this.onCapabilityEVChargerState(value);
    });
  }

  async onCapabilityEVChargerState(value) {
    const { siteId, reporterId } = this.getData();

    await this.client.setSiteDeviceApplianceActivationState({
      siteId,
      reporterId,
      state: {
        mode: 'MANUAL',
        level: value ? 100 : 0,
        duration: null,
      },
    });
  }

  async onPoll() {
    const { siteId, reporterId } = this.getData();

    const sitePowerflow = await this.client.getSitePowerflow({ siteId });
    const { evCharger } = sitePowerflow;

    // currentPower in kW; null when not charging
    if (evCharger?.currentPower === null) {
      await this.setCapability('measure_power', 0);
    } else if (typeof evCharger?.currentPower === 'number') {
      await this.setCapability('measure_power', Math.round(evCharger.currentPower * 1000));
    }

    if (evCharger?.connectionStatus) {
      const [chargingState, charging] = CONNECTION_STATES[evCharger.connectionStatus] || [null, null];
      if (chargingState === null) this.log('Unknown EV Charger connection status', evCharger.connectionStatus);
      await this.setCapability('evcharger_charging_state', chargingState);
      await this.setCapability('evcharger_charging', charging);
    }

    if (evCharger?.isActive) {
      await this.setAvailable();
    } else {
      await this.setUnavailable();
    }

    // devices paired before reporterId was stored cannot read their sessions
    if (!reporterId) {
      await this.setWarning(this.homey.__('errors.reAddDevice'));
      return;
    }

    if (!this.energyDue()) return;

    const applianceSessionsHistory = await this.client.getSiteDeviceApplianceSessionsHistory({ siteId, reporterId });

    if (Array.isArray(applianceSessionsHistory?.applianceDetails)) {
      // Wh, summed over the sessions of the last year
      let totalCharged = 0;
      applianceSessionsHistory.applianceDetails.forEach((applianceDetails) => {
        const statisticsConsumedEnergy = applianceDetails.statistics.find((statistic) => statistic.subjectEnum === 'CONSUMED_ENERGY');
        if (typeof statisticsConsumedEnergy?.totalValue === 'number') {
          totalCharged += statisticsConsumedEnergy.totalValue;
        }
      });
      await this.setCapability('meter_power.charged', totalCharged / 1000);
    }
  }

};
