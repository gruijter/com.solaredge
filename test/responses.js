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
 * The drivers and devices against recorded real API responses (test/captures, made by capture.js):
 * pairing and one poll per device, with time frozen at the capture. Catches what a local fake
 * server cannot: the API's real shapes no longer matching the code. Skips without captures.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  CAPTURES, freezeTime, pairAndPoll, replayClient,
} = require('./harness');

// may legitimately stay empty after a poll: a level other than 0 or 100 has no state
const MAY_STAY_EMPTY = ['solaredge-home-load-controller-state'];

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const resultOf = (capture, method) => capture.calls.find((call) => call.method === method && !call.error)?.result;

/** Checks on the data itself, not on how the code maps it. */
const DEVICE_CHECKS = {
  inverter: (values, capture, label) => {
    const totals = ['meter_power.day', 'meter_power.month', 'meter_power.year', 'meter_power'].map((id) => values[id]);
    check(totals.every((value, i) => i === 0 || totals[i - 1] <= value), `${label}: day <= month <= year <= lifetime, got ${totals.join(' / ')} kWh`);
    const power = resultOf(capture, 'getSitePowerflow')?.solarProduction?.currentPower;
    if (typeof power === 'number') check(values.measure_power === Math.round(power * 1000), `${label}: measure_power ${values.measure_power} W for ${power} kW`);
    const live = Object.values(resultOf(capture, 'getInvertersInformation')?.serialToLiveData || {});
    const phases = [1, 2, 3].map((phase) => values[`measure_power.${phase}`]).filter((value) => typeof value === 'number');
    if (live.length && phases.length) {
      const ac = live.reduce((total, item) => total + item.pAc_W, 0);
      const sum = phases.reduce((total, value) => total + value, 0);
      check(Math.abs(sum - ac) <= Math.max(5, ac * 0.02), `${label}: phases add up to ${sum} W, the inverters report ${ac} W`);
    }
  },
  meter: (values, capture, label) => {
    const years = capture.calls.filter((call) => call.method === 'getSiteMeasurements' && call.result?.summary);
    // kWh at Wh resolution, as the meter keeps them
    const sum = (field) => years.reduce((total, call) => total + (call.result.summary[field] ?? 0), 0) / 1000;
    const same = (value, expected) => typeof value === 'number' && Math.abs(value - expected) < 0.0005;
    check(same(values['meter_power.imported'], sum('import')), `${label}: imported ${values['meter_power.imported']} kWh, the years add up to ${sum('import')}`);
    check(same(values['meter_power.exported'], sum('export')), `${label}: exported ${values['meter_power.exported']} kWh, the years add up to ${sum('export')}`);
  },
};

// test/fixtures/synthetic-site.json (make-synthetic.js): what the drivers make of its made-up answers
const SYNTHETIC = path.join(__dirname, 'fixtures', 'synthetic-site.json');
const SYNTHETIC_EXPECTED = {
  meter: {
    measure_power: -1200, 'measure_power.load': 800, 'measure_power.solar': 5600, 'meter_power.imported': 4400, 'meter_power.exported': 8300, alarm_connectivity: false,
  },
  battery: {
    measure_power: 500, measure_battery: 62, battery_charging_state: 'charging', 'meter_power.charged': 1234.567, 'meter_power.discharged': 1000, measure_residual_energy: 6.2, measure_soh: 95,
  },
  evcharger: {
    // the charger's own CURRENT_POWER_WH, not the powerflow's 3.1 kW
    measure_power: 9509,
    evcharger_charging: true,
    evcharger_charging_state: 'plugged_in_charging',
    'meter_power.charged': 127.456,
    'meter_power.session': 0.093,
    ev_session_duration: 1,
    ev_charge_mode: 'manual',
    ev_solar_charging: false,
    ev_vehicle: 'Ioniq',
  },
  'home-load-controller': { 'solaredge-home-load-controller-state': 'on', measure_power: 2000 },
  inverter: { measure_power: 5600, alarm_problem: true, inverter_status: 'production' },
};

const runSite = async (file) => {
  const capture = JSON.parse(fs.readFileSync(file, 'utf8'));
  freezeTime(capture.capturedAt);
  const results = await pairAndPoll({ client: replayClient(capture.calls), site: capture.site });
  const site = `${capture.synthetic ? 'synthetic ' : ''}${capture.partial ? 'partial ' : ''}site ${capture.site.id}`;
  // a partial capture holds only some calls: what needs another one is skipped, not failed
  const skipped = (error) => capture.partial && /not captured/.test(error?.message ?? error ?? '');

  const skips = [];
  for (const result of results) {
    if (skipped(result.thrown)) {
      skips.push(`${result.driverId} pairing`);
      continue;
    }
    check(!result.thrown, `${site} ${result.driverId}: pairing threw ${result.thrown?.message}`);
    for (const { device, offer, thrown } of result.devices) {
      const label = `${site} ${result.driverId}`;
      if (skipped(thrown)) {
        console.log(`  ${label}: paired ${JSON.stringify(device.getData())}`);
        skips.push(`${result.driverId} poll`);
        continue;
      }
      check(!thrown, `${label}: poll threw ${thrown?.message}`);
      device.problems.filter((problem) => !skipped(problem)).forEach((problem) => failures.push(`${label}: ${problem}`));
      // pairing gave it every capability its first poll sets: no migration
      check(device.getCapabilities().join() === offer.capabilities.join(),
        `${label}: paired with ${offer.capabilities.join(', ')}, migrated to ${device.getCapabilities().join(', ')}`);
      if (capture.partial) {
        console.log(`  ${label} ${device.available ? 'available' : 'unavailable'}: ${JSON.stringify(device.values)}`);
        continue;
      }
      const empty = Object.keys(device.values).filter((id) => device.values[id] === null && !MAY_STAY_EMPTY.includes(id));
      check(!empty.length, `${label}: left empty: ${empty.join(', ')}`);
      DEVICE_CHECKS[result.driverId]?.(device.values, capture, label);
      if (capture.synthetic) {
        for (const [id, value] of Object.entries(SYNTHETIC_EXPECTED[result.driverId] || {})) {
          check(device.values[id] === value, `${label}: ${id} is ${JSON.stringify(device.values[id])}, expected ${JSON.stringify(value)}`);
        }
      }
      console.log(`  ${label} ${device.available ? 'available' : 'unavailable'}: ${JSON.stringify(device.values)}`);
    }
  }
  if (skips.length) console.log(`  ${site}: skipped (calls not in the capture): ${skips.join(', ')}`);
  const offered = results.filter((result) => result.offered?.length).map((result) => result.driverId);
  console.log(`  ${site} (captured ${new Date(capture.capturedAt).toISOString()}) offers: ${offered.join(', ') || 'nothing'}`);
};

const run = async () => {
  const captured = fs.existsSync(CAPTURES) ? fs.readdirSync(CAPTURES).filter((file) => file.endsWith('.json')).sort() : [];
  if (!captured.length) console.log('responses: no captures in test/captures (see test/captures/README.md)');
  const files = [SYNTHETIC, ...captured.map((file) => path.join(CAPTURES, file))];
  for (const file of files) await runSite(file); // eslint-disable-line no-await-in-loop

  if (failures.length) {
    console.log(`\nFAIL - ${failures.length} problem(s):`);
    failures.forEach((failure) => console.log(`  ${failure}`));
    process.exitCode = 1;
  } else {
    console.log(`OK - ${captured.length} capture(s) and the synthetic site`);
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
