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
 * Write test/fixtures/synthetic-site.json: a made-up site with grid meter, battery, EV charger and
 * home load controller, so responses.js runs every driver until real captures exist. The
 * inverter answers are Dijker's (live); everything else follows the field names of other projects
 * (zzz_docs/solaredge-cloud-api.md) and is NOT seen live.
 *
 *   node test/make-synthetic.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { freezeTime, pairAndPoll, recordingClient } = require('./harness');

const SITE_ID = 9999999;
const CAPTURED_AT = Date.UTC(2026, 9, 15, 11, 0, 0);
const live = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'inverter-live.json'), 'utf8'));
// a real getSiteDevices answer with an EV charger, from another project (see its _source)
const evAnswer = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ev-charger-devices.json'), 'utf8')).responses.charging;
const answer = (method) => structuredClone(live.find((call) => call.method === method).result);

const site = {
  id: SITE_ID, status: 'ACTIVE', name: 'Synthetic site', peakPower: 8, timezone: 'Europe/Amsterdam', installationDate: '2024-03-01T10:00:00Z',
};
const loadController = {
  reporterId: 102,
  serialNumber: 'HLC0001',
  name: 'Boiler',
  type: 'ON_OFF',
  activationMode: 'MANUAL',
  status: { level: 100, activePowerMeter: null },
  config: { ratedPower: 2000 },
  deviceStatus: 'ACTIVE',
};
const YEARS = { 2024: [1200000, 2500000], 2025: [1800000, 3100000], 2026: [1400000, 2700000] };

const backend = {
  getSites: async () => ({ [SITE_ID]: site }),
  getSitePowerflow: async () => ({
    updateRefreshRate: 3,
    isRealTime: true,
    isCommunicating: true,
    unit: 'kW',
    grid: {
      isActive: true, currentPower: 1.2, status: 'export', hasPowerOutage: false,
    },
    consumption: { isActive: true, currentPower: 0.8, isConsuming: true },
    solarProduction: { isActive: true, currentPower: 5.6, isProducing: true },
    storage: {
      isActive: true, currentPower: 0.5, chargeLevel: 62, status: 'charging', storagePlan: 'MSC',
    },
    evCharger: {
      isActive: true, connectionStatus: 'charging', currentPower: 3.1, faultLabel: null, label: null,
    },
  }),
  // the EV charger only in devicesByType, as in the real answer; the load controller in devices, as the original app reads it
  getSiteDevices: async () => ({ ...evAnswer, devices: [loadController] }),
  getSiteDeviceApplianceSessionsHistory: async () => ({
    applianceDetails: [{ statistics: [{ subjectEnum: 'CONSUMED_ENERGY', totalValue: 123456 }] }, { statistics: [{ subjectEnum: 'CONSUMED_ENERGY', totalValue: 4000 }] }],
  }),
  getSiteBatteries: async () => ({
    status: 'PASSED',
    devicesByType: {
      BATTERY: [{
        batteryState: 'CHARGING',
        chargeEnergy: 1234567,
        dischargeEnergy: 1000000,
        remainingEnergy: 6200,
        fullPackEnergy: 9200,
        namePlateEnergy: 9700,
        communicationStatus: 'ACTIVE',
        info: { serialNumber: 'BAT0001', model: 'BAT-10K1P' },
      }],
    },
  }),
  getSiteMeasurements: async ({ endDate }) => {
    const totals = YEARS[endDate.slice(0, 4)];
    if (!totals) throw new Error('INVALID_ARGUMENTS');
    return { summary: { import: totals[0], export: totals[1] } };
  },
  getSiteEnergyOverview: async () => answer('getSiteEnergyOverview'),
  getSiteEquipment: async () => answer('getSiteEquipment'),
  getInvertersInformation: async () => answer('getInvertersInformation'),
  getSiteEnergyByInverter: async () => answer('getSiteEnergyByInverter'),
  getSiteCommunication: async () => ({ connectivityStatus: 'ONLINE', active: true }),
  getSiteAlerts: async () => ({ totalAlertsCount: 1, topAlerts: [] }),
};

(async () => {
  freezeTime(CAPTURED_AT);
  const { client, calls } = recordingClient(backend);
  const results = await pairAndPoll({ client, site });
  results.filter((result) => result.thrown).forEach((result) => console.error(`${result.driverId}: ${result.thrown.message}`));
  const file = path.join(__dirname, 'fixtures', 'synthetic-site.json');
  fs.writeFileSync(file, `${JSON.stringify({
    synthetic: true, capturedAt: CAPTURED_AT, site, calls: [...calls.values()],
  }, null, 1)}\n`);
  console.log(`${calls.size} calls -> ${path.relative(process.cwd(), file)}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
