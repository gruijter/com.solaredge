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
  },
  meter: (values, capture, label) => {
    const years = capture.calls.filter((call) => call.method === 'getSiteMeasurements' && call.result?.summary);
    const sum = (field) => Math.round(years.reduce((total, call) => total + (call.result.summary[field] ?? 0), 0) / 1000);
    check(values['meter_power.imported'] === sum('import'), `${label}: imported ${values['meter_power.imported']} kWh, the years add up to ${sum('import')}`);
    check(values['meter_power.exported'] === sum('export'), `${label}: exported ${values['meter_power.exported']} kWh, the years add up to ${sum('export')}`);
  },
};

const runSite = async (file) => {
  const capture = JSON.parse(fs.readFileSync(path.join(CAPTURES, file), 'utf8'));
  freezeTime(capture.capturedAt);
  const results = await pairAndPoll({ client: replayClient(capture.calls), site: capture.site });
  const site = `site ${capture.site.id}`;

  for (const result of results) {
    check(!result.thrown, `${site} ${result.driverId}: pairing threw ${result.thrown?.message}`);
    for (const { device, thrown } of result.devices) {
      const label = `${site} ${result.driverId}`;
      check(!thrown, `${label}: poll threw ${thrown?.message}`);
      device.problems.forEach((problem) => failures.push(`${label}: ${problem}`));
      const empty = Object.keys(device.values).filter((id) => device.values[id] === null && !MAY_STAY_EMPTY.includes(id));
      check(!empty.length, `${label}: left empty: ${empty.join(', ')}`);
      DEVICE_CHECKS[result.driverId]?.(device.values, capture, label);
      console.log(`  ${label} ${device.available ? 'available' : 'unavailable'}: ${JSON.stringify(device.values)}`);
    }
  }
  const offered = results.filter((result) => result.offered?.length).map((result) => result.driverId);
  console.log(`  ${site} (captured ${new Date(capture.capturedAt).toISOString()}) offers: ${offered.join(', ') || 'nothing'}`);
};

const run = async () => {
  const files = fs.existsSync(CAPTURES) ? fs.readdirSync(CAPTURES).filter((file) => file.endsWith('.json')).sort() : [];
  if (!files.length) {
    console.log('responses: no captures in test/captures, skipped (see test/captures/README.md)');
    return;
  }
  for (const file of files) await runSite(file); // eslint-disable-line no-await-in-loop

  if (failures.length) {
    console.log(`\nFAIL - ${failures.length} problem(s):`);
    failures.forEach((failure) => console.log(`  ${failure}`));
    process.exitCode = 1;
  } else {
    console.log(`OK - ${files.length} captured site(s)`);
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
