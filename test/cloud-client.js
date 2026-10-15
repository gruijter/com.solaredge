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
 * SolarEdgeCloudClient against a local server that mimics monitoring.solaredge.com: the cookie
 * login (302), session expiry (401), error codes, request coalescing and the PUT body.
 * No network or credentials needed.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const SolarEdgeCloudClient = require('../lib/SolarEdgeCloudClient');

const requests = [];
let sessionValid = true;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    requests.push({
      method: req.method, url: req.url, headers: req.headers, body,
    });
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (req.url === '/solaredge-apigw/api/login') {
      const form = new URLSearchParams(body);
      if (form.get('j_password') !== 'secret') {
        json(200, {});
        return;
      }
      sessionValid = true;
      res.setHeader('Set-Cookie', ['JSESSIONID=abc; Path=/; HttpOnly', 'SPRING=xyz; Path=/']);
      res.writeHead(302, { Location: '/solaredge-web/p/home' });
      res.end();
      return;
    }
    if (!sessionValid || req.headers.cookie !== 'JSESSIONID=abc; SPRING=xyz') {
      json(401, {});
      return;
    }
    if (req.url.startsWith('/services/m/so/sites/')) {
      json(200, { sites: { 1: { id: 1, name: 'Home' } } });
      return;
    }
    if (req.url.includes('/powerflow/latest')) {
      // slow enough for concurrent callers to overlap
      setTimeout(() => json(200, { solarProduction: { currentPower: 1.234 } }), 50);
      return;
    }
    if (req.url.includes('/measurements')) {
      json(400, { code: 'INVALID_ARGUMENTS' });
      return;
    }
    if (req.url.endsWith('/activationState')) {
      json(200, { ok: true });
      return;
    }
    res.writeHead(500, 'Server Error');
    res.end('not json');
  });
});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const newClient = (password = 'secret') => new SolarEdgeCloudClient({ username: 'user@example.com', password });
const count = (predicate) => requests.filter(predicate).length;
const isLogin = (r) => r.url === '/solaredge-apigw/api/login';

test('login keeps the session cookies of the 302', async () => {
  const client = newClient();
  await client.login();
  assert.deepEqual(client.cookies, ['JSESSIONID=abc', 'SPRING=xyz']);
  const login = requests.find(isLogin);
  assert.equal(login.method, 'POST');
  assert.equal(login.headers['content-type'], 'application/x-www-form-urlencoded;charset=UTF-8');
  assert.equal(new URLSearchParams(login.body).get('j_username'), 'user@example.com');
});

test('a wrong password throws and leaves no session', async () => {
  const client = newClient('wrong');
  await assert.rejects(client.login(), /Invalid e-mail and\/or password\./);
  assert.equal(client.isLoggedIn(), false);
});

test('the first call logs in, with the app headers and cookies', async () => {
  const client = newClient();
  const sites = await client.getSites();
  assert.deepEqual(sites, { 1: { id: 1, name: 'Home' } });
  const call = requests.at(-1);
  assert.equal(call.headers['user-agent'], SolarEdgeCloudClient.HEADERS['User-Agent']);
  assert.equal(call.headers['client-version'], '3.12');
  assert.equal(count(isLogin), 1);
});

test('concurrent callers share one login and one identical GET', async () => {
  const client = newClient();
  const results = await Promise.all([1, 2, 3, 4].map(() => client.getSitePowerflow({ siteId: 1 })));
  results.forEach((result) => assert.equal(result.solarProduction.currentPower, 1.234));
  assert.equal(count(isLogin), 1);
  assert.equal(count((r) => r.url.includes('/powerflow/latest')), 1);
  // after it settled, the next GET goes out again
  await client.getSitePowerflow({ siteId: 1 });
  assert.equal(count((r) => r.url.includes('/powerflow/latest')), 2);
});

test('a 401 drops the session; the next call logs in again', async () => {
  const client = newClient();
  await client.getSites();
  sessionValid = false;
  await assert.rejects(client.getSites(), /^Error: Unauthorized$/);
  assert.equal(client.isLoggedIn(), false);
  await client.getSites();
  assert.equal(count(isLogin), 2);
});

test('the error code of a JSON error is the message', async () => {
  const client = newClient();
  await assert.rejects(client.getSiteMeasurements({ siteId: 1, endDate: '2020-12-31' }), /^Error: INVALID_ARGUMENTS$/);
  const call = requests.find((r) => r.url.includes('/measurements'));
  assert.equal(call.url, '/services/m/so/dashboard/site/1/measurements?period=YEAR&measurement-unit=WATT_HOUR&end-date=2020-12-31');
});

test('a non-JSON error gives the status text', async () => {
  const client = newClient();
  await assert.rejects(client.getSite({ siteId: 1 }), /^Error: Server Error$/);
});

test('activationState is a JSON PUT', async () => {
  const client = newClient();
  const state = { mode: 'MANUAL', level: 100, duration: null };
  await client.setSiteDeviceApplianceActivationState({ siteId: 1, reporterId: 7, state });
  const call = requests.at(-1);
  assert.equal(call.method, 'PUT');
  assert.equal(call.url, '/services/m/api/homeautomation/v1.0/1/devices/7/activationState');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(call.body), state);
});

async function run() {
  // send the client's https://monitoring.solaredge.com calls to the local server
  const realFetch = globalThis.fetch;
  const local = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = (url, opts) => realFetch(String(url).replace('https://monitoring.solaredge.com', local), opts);

  let failed = 0;
  for (const { name, fn } of tests) {
    requests.length = 0;
    sessionValid = true;
    try {
      // eslint-disable-next-line no-await-in-loop
      await fn();
      console.log(`  ok    ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAIL  ${name}\n        ${error.message}`);
    }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
}

server.listen(0, '127.0.0.1', () => {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
});
