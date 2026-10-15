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
 * Record the real API responses of a mySolarEdge account into test/captures/<siteId>.json, for
 * responses.js. Runs the app's own pairing and one poll per device, so it records exactly what
 * the app asks; writes are refused.
 *
 *   SOLAREDGE_USERNAME=... SOLAREDGE_PASSWORD=... node test/capture.js
 */

const fs = require('node:fs');
const path = require('node:path');
const SolarEdgeCloudClient = require('../lib/SolarEdgeCloudClient');
const { CAPTURES, pairAndPoll, recordingClient } = require('./harness');

const { SOLAREDGE_USERNAME: username, SOLAREDGE_PASSWORD: password } = process.env;

const run = async () => {
  if (!username || !password) throw new Error('set SOLAREDGE_USERNAME and SOLAREDGE_PASSWORD');
  const api = new SolarEdgeCloudClient({ username, password });
  const sites = Object.values(await api.getSites());
  fs.mkdirSync(CAPTURES, { recursive: true });

  for (const site of sites) {
    const capturedAt = Date.now();
    const { client, calls } = recordingClient(api);
    const results = await pairAndPoll({ client, site }); // eslint-disable-line no-await-in-loop

    // the account's other sites stay out of this site's capture
    const recorded = [...calls.values()].map((call) => (call.method === 'getSites'
      ? { ...call, result: { [site.id]: site } }
      : call));
    if (!recorded.some((call) => call.method === 'getSites')) {
      recorded.push({ method: 'getSites', result: { [site.id]: site } });
    }

    const file = path.join(CAPTURES, `${site.id}.json`);
    fs.writeFileSync(file, `${JSON.stringify({ capturedAt, site, calls: recorded }, null, 1)}\n`);
    const offered = results.filter((result) => result.offered?.length).map((result) => result.driverId);
    console.log(`site ${site.id}: ${recorded.length} calls -> ${path.relative(process.cwd(), file)}`
      + ` (drivers offered: ${offered.join(', ') || 'none'})`);
  }
};

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
