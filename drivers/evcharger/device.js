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
const siteDevices = require('../../lib/siteDevices');

// connectionStatus -> [evcharger_charging_state, evcharger_charging]; lower case in the powerflow
// (original app), upper case in getSiteDevices (briadelour example_raw_json)
const CONNECTION_STATES = {
  connected: ['plugged_in', false],
  charging: ['plugged_in_charging', true],
  disconnected: ['plugged_out', false],
};

const ACTIVATION_MODES = { AUTO: 'auto', MANUAL: 'manual' };
// excessPV: -1 solar surplus charging on, -2 off (briadelour const.py, example_raw_json)
const EXCESS_PV = { '-1': true, '-2': false };

/** The session values of the charger's getSiteDevices entry (updateSession). */
const sessionValues = (charger) => {
  const energy = finite(charger.sessionEnergy);
  const duration = finite(charger.sessionDuration);
  return {
    'meter_power.session': energy === null ? null : energy / 1000,
    ev_session_duration: duration === null ? null : Math.round(duration / 60),
    ev_charge_mode: ACTIVATION_MODES[charger.activationMode] ?? null,
    ev_solar_charging: EXCESS_PV[charger.excessPV] ?? null,
    ev_vehicle: typeof charger.applianceData?.alias === 'string' ? charger.applianceData.alias : null,
  };
};

/** The charger's entry in a getSiteDevices answer. */
const chargerIn = (response, reporterId) => siteDevices(response).find((item) => String(item.reporterId) === String(reporterId));

module.exports = class SolarEdgeEVChargerDevice extends CommonDevice {

  async onInit() {
    await super.onInit();

    this.registerCapabilityListener('evcharger_charging', async (value) => {
      await this.onCapabilityEVChargerState(value);
    });
  }

  /** Back to the charger's own control: schedule and solar surplus (activationState AUTO). */
  async setAutomatic() {
    const { siteId, reporterId } = this.getData();
    // the payload of the hot-water projects (barnold89, rolflied); an EV charger in AUTO is seen in
    // briadelour's example_raw_json, switching one to it from here is not
    await this.client.setSiteDeviceApplianceActivationState({ siteId, reporterId, state: { mode: 'AUTO' } });
    this.log(this.getName(), 'set to automatic');
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

  async setConnectionStatus(status) {
    const [chargingState, charging] = CONNECTION_STATES[String(status).toLowerCase()] || [null, null];
    if (chargingState === null) this.logOnce(`status ${status}`, 'unknown connection status', status);
    await this.setCapability('evcharger_charging_state', chargingState);
    await this.setCapability('evcharger_charging', charging);
  }

  async onPoll() {
    const { siteId, reporterId } = this.getData();

    const sitePowerflow = await this.client.getSitePowerflow({ siteId });
    const { evCharger } = sitePowerflow;

    if (evCharger?.connectionStatus) await this.setConnectionStatus(evCharger.connectionStatus);

    // devices paired before reporterId was stored cannot read their sessions
    if (!reporterId) {
      await this.setWarning(this.homey.__('errors.reAddDevice'));
    }

    // optional readings: a failure leaves the device as it is
    const session = reporterId
      ? await this.updateSession(!evCharger?.connectionStatus).catch((error) => {
        this.error(`Error Fetching Site Devices: ${error.message}`);
        return null;
      })
      : null;

    // the powerflow's evCharger is one per site (seen live): this charger's own power comes first
    let power = session?.power ?? null;
    // currentPower in kW; null when not charging
    if (power === null && evCharger?.currentPower === null) power = 0;
    if (power === null && typeof evCharger?.currentPower === 'number') power = Math.round(evCharger.currentPower * 1000);
    if (power !== null) await this.setCapability('measure_power', power);

    if (evCharger?.isActive || session?.active) {
      await this.setAvailable();
    } else {
      await this.setUnavailable();
    }

    if (reporterId && this.energyDue()) {
      await this.updateCharged().catch((error) => this.error(`Error Fetching Sessions: ${error.message}`));
    }
  }

  /**
   * meter_power.charged: Wh, summed over all sessions: the history honours startTime (seen live:
   * 1662 kWh from 0, 607 kWh over 30 days), so startTime 0 gives every session since the first.
   */
  async updateCharged() {
    const { siteId, reporterId } = this.getData();
    const applianceSessionsHistory = await this.client.getSiteDeviceApplianceSessionsHistory({ siteId, reporterId });
    // PASSED with applianceDetails null: no sessions yet (seen live)
    const none = applianceSessionsHistory?.status === 'PASSED' && applianceSessionsHistory.applianceDetails === null;
    if (!none && !Array.isArray(applianceSessionsHistory?.applianceDetails)) return;

    let totalCharged = 0;
    (applianceSessionsHistory.applianceDetails || []).forEach((applianceDetails) => {
      const statisticsConsumedEnergy = (applianceDetails?.statistics || []).find((statistic) => statistic.subjectEnum === 'CONSUMED_ENERGY');
      if (typeof statisticsConsumedEnergy?.totalValue === 'number') {
        totalCharged += statisticsConsumedEnergy.totalValue;
      }
    });
    // a total that falls (a vehicle removed with its sessions, assumed): monotonic() keeps the Energy meter rising
    await this.setCapability('meter_power.charged', await this.monotonic('charged', totalCharged / 1000));
  }

  /**
   * The charger's entry in getSiteDevices (devicesByType.EV_CHARGER; seen in briadelour's
   * example_raw_json, not on a site of ours): sessionEnergy Wh, sessionDuration s, activationMode
   * AUTO/MANUAL, excessPV, applianceData.alias. The session values stay after unplugging
   * (sessionActive false) and show the last session.
   * @param {boolean} withStatus also take the connection status: the powerflow had none
   * @returns {Promise<{active: boolean, power: (number|null)}|null>} null when the charger is not
   *   listed. active: deviceStatus ACTIVE (seen in the KEBA answer of solaredge-evcharger-ha#6).
   *   power in W: chargerStatusSubTitle CURRENT_POWER_WH (W despite its name: 93 Wh after 38 s
   *   at 9509 W), present only while charging, so 0 otherwise. 0 while charging is no reading (the
   *   KEBA answer: 0.0 after 3502 Wh in 1376 s), nor is a missing connectionStatus: null then.
   */
  async updateSession(withStatus) {
    const { siteId, reporterId } = this.getData();
    const charger = chargerIn(await this.client.getSiteDevices({ siteId }), reporterId);
    if (!charger) {
      this.logOnce('not in devices', 'not in getSiteDevices');
      return null;
    }

    const state = {
      activationMode: charger.activationMode,
      chargerStatus: charger.chargerStatus,
      connectionStatus: charger.connectionStatus,
      excessPV: charger.excessPV,
      sessionSolarUsage: charger.sessionSolarUsage,
      type: charger.type,
    };
    this.logOnce(`state ${JSON.stringify(state)}`, 'charger state', JSON.stringify(state));
    if (charger.activationMode && !ACTIVATION_MODES[charger.activationMode]) this.logOnce(`mode ${charger.activationMode}`, 'unknown activationMode', charger.activationMode);
    if (withStatus && charger.connectionStatus) await this.setConnectionStatus(charger.connectionStatus);

    const values = sessionValues(charger);
    await this.recordSeenCaps(values);
    for (const [capability, value] of Object.entries(values)) {
      // eslint-disable-next-line no-await-in-loop
      if (value !== null) await this.setCapability(capability, value);
    }
    const subTitle = (charger.chargerStatusSubTitle || []).find((item) => item.subStatusTitle === 'CURRENT_POWER_WH');
    const status = String(charger.connectionStatus || '').toUpperCase();
    let power = finite(subTitle?.numericValue);
    if (status === 'CHARGING' && power === 0) power = null;
    if (power === null && status && status !== 'CHARGING') power = 0;
    return { active: charger.deviceStatus === 'ACTIVE', power: power === null ? null : Math.round(power) };
  }

  /** The readings of updateSession, for pairing (lib/common_driver.js): the same call. */
  static async pairValues({ client, site, device }) {
    const charger = chargerIn(await client.getSiteDevices({ siteId: site.id }), device.data.reporterId);
    return charger ? sessionValues(charger) : {};
  }

};
