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
An inverter that is asleep for the night stops uploading; its last measurement stays in
getInvertersInformation. Seen on Dijker's site (2026-10-15, Homey Insights next to a local Modbus
reading of the same inverter): 0 W from 18:40, DC 0.6 V from 18:55, last upload about then, site not
ONLINE from 20:02 until the inverter woke at 08:15; inverterStatus stayed 'production'.
With a battery the inverter stays awake while it discharges (pAc_W is the discharge, not 0), so
isAsleep() stays false then (reported by a tester, not verified).
*/

const { PERIOD_MS } = require('./solarEdgeTiming');

// a measurement this long past its upload interval is the last one before the inverter stopped
// uploading (as judgesTick in solarEdgeTiming.js)
const SILENT_MS = PERIOD_MS;
// silent longer than this is not a night (24 h: nights differ per latitude, polar nights excepted)
const MAX_SLEEP_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the inverters stopped uploading after their output had fallen to 0 W: asleep, not cut
 * off while producing. An inverter whose last status was fault is not asleep: its fault stays.
 * @param {object[]} live serialToLiveData values: lastMeasurement (ISO), pAc_W, inverterStatus
 * @param {object} [options]
 * @param {number} [options.cadenceMs] the site's upload interval (app.js learns it), else PERIOD_MS
 * @param {number} [options.nowMs]
 */
const isAsleep = (live, { cadenceMs = PERIOD_MS, nowMs = Date.now() } = {}) => {
  if (!live.length) return false;
  return live.every((item) => {
    const silentMs = nowMs - Date.parse(item.lastMeasurement);
    return item.pAc_W === 0 && String(item.inverterStatus).toLowerCase() !== 'fault'
      && silentMs >= cadenceMs + SILENT_MS && silentMs < MAX_SLEEP_MS;
  });
};

module.exports = { isAsleep, SILENT_MS, MAX_SLEEP_MS };
