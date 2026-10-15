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
 * Turn a user's diagnostics report into test captures for responses.js:
 *
 *   node test/from-logs.js <report.txt>          write test/captures/<siteId>.json per site
 *   node test/from-logs.js <report.txt> --dry    show what it found, write nothing
 *   node test/from-logs.js <report.txt> --force  overwrite captures that already exist
 *
 * Reads the capture blocks written by lib/solarEdgeCapture.js. Calls without a siteId (getSites,
 * per-serial calls) go to every site. Time is frozen at the first captured call.
 */

const fs = require('node:fs');
const path = require('node:path');
const capture = require('../lib/solarEdgeCapture');
const { CAPTURES } = require('./harness');

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith('--'));
const dryRun = args.includes('--dry');
const force = args.includes('--force');

if (!file || !fs.existsSync(file)) {
  console.error('usage: node test/from-logs.js <report.txt> [--dry] [--force]');
  process.exit(1);
}

const { calls, errors } = capture.parseLog(fs.readFileSync(file, 'utf8'));
errors.forEach((error) => console.error(`  ! ${error}`));
if (!calls.length) {
  console.error('No capture blocks found.');
  process.exit(1);
}

const sitesCall = calls.find((call) => call.method === 'getSites' && call.result);
const siteIds = [...new Set(calls.map((call) => call.args?.siteId).filter((id) => id !== undefined).map(String))];
if (!siteIds.length) {
  console.error('No site calls found.');
  process.exit(1);
}

for (const siteId of siteIds) {
  const site = Object.values(sitesCall?.result || {}).find((item) => String(item.id) === siteId) || { id: Number(siteId) };
  const siteCalls = calls
    .filter((call) => call.args?.siteId === undefined || String(call.args.siteId) === siteId)
    .map((call) => (call.method === 'getSites' ? { ...call, result: { [siteId]: site } } : call));
  if (!siteCalls.some((call) => call.method === 'getSites')) siteCalls.push({ method: 'getSites', result: { [siteId]: site } });
  const capturedAt = Math.min(...siteCalls.map((call) => call.at).filter((at) => typeof at === 'number'));
  const out = path.join(CAPTURES, `${siteId}.json`);

  const methods = [...new Set(siteCalls.map((call) => call.method))].sort();
  console.log(`site ${siteId}: ${siteCalls.length} calls (${methods.join(', ')})`);
  if (dryRun) continue;
  if (fs.existsSync(out) && !force) {
    console.log(`  ${path.relative(process.cwd(), out)} exists, skipped (--force to overwrite)`);
    continue;
  }
  fs.mkdirSync(CAPTURES, { recursive: true });
  const stripped = siteCalls.map(({ at, ...call }) => call); // eslint-disable-line no-unused-vars
  fs.writeFileSync(out, `${JSON.stringify({ capturedAt, site, calls: stripped }, null, 1)}\n`);
  console.log(`  -> ${path.relative(process.cwd(), out)}`);
}
