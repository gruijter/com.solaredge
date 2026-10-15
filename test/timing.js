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
 * The energy tick (lib/solarEdgeTiming.js, app.js): placed a margin after the inverters'
 * measurement moment, the margin following whether a tick found new data, a sleeping inverter
 * left out, and the fast tick unaffected.
 */

const path = require('node:path');
require('./harness'); // the homey stub
const {
  PERIOD_MS, MARGIN_MS, tickPhase, adaptMargin, delayToNextTick,
} = require('../lib/solarEdgeTiming');

const App = require(path.join(__dirname, '..', 'app.js')); // eslint-disable-line import/no-dynamic-require

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

// functions: measured moments xx:x0:28 / xx:x5:28 (site 1665942)
const at28 = Date.UTC(2026, 9, 15, 12, 40, 28);
check(tickPhase([at28]) === 28000 + MARGIN_MS, `tickPhase ${tickPhase([at28])}`);
check(tickPhase([]) === 0, 'tickPhase without snapshots');
check(tickPhase([at28, at28 + 2.5 * 60000]) === 0, 'tickPhase of inverters far apart');
check(adaptMargin(MARGIN_MS, false) === MARGIN_MS + 15000 && adaptMargin(MARGIN_MS + 15000, true) === MARGIN_MS + 10000, 'adaptMargin');
const now = Date.UTC(2026, 9, 15, 12, 41, 0);
check(delayToNextTick(now, 48000) === (5 * 60 + 48 - 60) * 1000, `delayToNextTick ${delayToNextTick(now, 48000)}`);

// app: a fake clock for timers
const timers = [];
const homey = {
  setInterval: (fn, ms) => timers.push({ fn, ms, interval: true }) && timers.length,
  clearInterval: () => {},
  setTimeout: (fn, ms) => timers.push({ fn, ms }) && timers.length,
  clearTimeout: () => {},
  emit: (...args) => homey.emitted.push(args),
  emitted: [],
};
const app = new App();
app.homey = homey;
app.log = () => {};
app.pollers = new Map();
const client = { backoffUntil: 0 };

const RealNow = Date.now;
Date.now = () => now;
app.setPollInterval(client, 10);
const poller = app.pollers.get(client);
check(timers.some((timer) => timer.interval && timer.ms === 10000), 'no fast tick of 10 s');
check(poller.phaseMs === 0, 'energy tick phase before any measurement');

app.noteSnapshot(client, 'INV1', at28);
check(poller.phaseMs === 28000 + MARGIN_MS, `phase after the first measurement: ${poller.phaseMs}`);
const lastTimeout = timers.filter((timer) => !timer.interval).pop();
check(lastTimeout.ms === delayToNextTick(now, 28000 + MARGIN_MS), `energy tick in ${lastTimeout.ms} ms`);

// the energy tick fires: devices get energy: true
lastTimeout.fn();
check(homey.emitted.some(([, , options]) => options?.energy === true), 'energy tick did not ask for energy');

// it found the same measurement: too early, margin grows and the tick moves later
app.noteSnapshot(client, 'INV1', at28);
check(poller.marginMs === MARGIN_MS + 15000 && poller.phaseMs === 28000 + MARGIN_MS + 15000, `margin ${poller.marginMs}, phase ${poller.phaseMs} after no new data`);

// next tick finds a new one: the margin eases back
poller.judgePending = true;
Date.now = () => at28 + PERIOD_MS + 40000;
app.noteSnapshot(client, 'INV1', at28 + PERIOD_MS);
check(poller.marginMs === MARGIN_MS + 10000, `margin ${poller.marginMs} after new data`);

// a sleeping inverter (old measurement) does not judge the tick
poller.judgePending = true;
Date.now = () => at28 + 10 * PERIOD_MS;
app.noteSnapshot(client, 'INV1', at28 + PERIOD_MS);
check(poller.marginMs === MARGIN_MS + 10000 && poller.judgePending, 'a stale measurement changed the margin');

Date.now = RealNow;
app.stopPolling(client);

if (failures.length) {
  console.error(`FAIL - ${failures.length} problem(s):\n`);
  failures.forEach((failure) => console.error(`  ${failure}`));
  process.exitCode = 1;
} else {
  console.log('OK - timing: energy tick follows the inverter data, margin adapts, night ignored');
}
