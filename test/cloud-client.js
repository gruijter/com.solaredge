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
 * SolarEdgeCloudClient against a local server that mimics monitoring.solaredge.com and
 * login.solaredge.com: the OAuth2 PKCE login, token refresh, token expiry (401), error codes,
 * request coalescing, the PUT body, the login backoff, the outage backoff and the pairing deadline.
 * No network or credentials needed.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const SolarEdgeCloudClient = require('../lib/SolarEdgeCloudClient');

const requests = [];
let sessionValid = true;
// every API call answers 401, also right after a login
let rejectSession = false;
// the refresh token is no longer accepted
let refreshValid = true;
let issued = 0;
let validToken = null;
let challenge = null;

const FORM_PAGE = '<form method="post" action="/login?x=1"><input type="hidden" name="csrf" value="csrf1"/>'
  + '<input name="username" value=""/><input name="password" value=""/></form>';

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

    const url = new URL(req.url, 'http://local');
    const issue = (refreshToken) => {
      issued += 1;
      validToken = `at${issued}`;
      sessionValid = true;
      json(200, {
        access_token: validToken, id_token: 'id', refresh_token: refreshToken, expires_in: 86400, token_type: 'Bearer',
      });
    };

    if (url.pathname === '/oauth2/authorize') {
      challenge = url.searchParams.get('code_challenge');
      res.setHeader('Set-Cookie', ['XSRF-TOKEN=x1; Path=/; Secure', 'csrf-state=s1; Path=/']);
      res.writeHead(302, { Location: `/login${url.search}` });
      res.end();
      return;
    }
    if (url.pathname === '/login' && req.method === 'GET') {
      res.setHeader('Set-Cookie', ['cognito=c1; Path=/', 'XSRF-TOKEN=x2; Path=/']);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(FORM_PAGE);
      return;
    }
    if (url.pathname === '/login') {
      const form = new URLSearchParams(body);
      if (form.get('password') === 'locked') {
        json(500, {});
        return;
      }
      if (form.get('password') === 'gone') {
        res.writeHead(410, { 'Content-Type': 'text/html' });
        res.end('legacy api');
        return;
      }
      if (form.get('password') === 'mfa') {
        res.writeHead(302, { Location: '/mfa?session=1' });
        res.end();
        return;
      }
      if (form.get('password') !== 'secret' || form.get('csrf') !== 'csrf1'
        || req.headers.cookie !== 'XSRF-TOKEN=x2; csrf-state=s1; cognito=c1') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(FORM_PAGE);
        return;
      }
      res.writeHead(302, { Location: 'https://monitoring.solaredge.com/mfe/auth/callback?code=code1' });
      res.end();
      return;
    }
    if (url.pathname === '/oauth2/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') {
        const verified = crypto.createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === challenge;
        if (form.get('code') !== 'code1' || !verified) {
          json(400, { error: 'invalid_grant' });
          return;
        }
        issue('rt1');
        return;
      }
      if (form.get('refresh_token') !== 'rt1' || !refreshValid) {
        json(400, { error: 'invalid_grant' });
        return;
      }
      // Cognito sends no new refresh token on a refresh
      issue(undefined);
      return;
    }
    if (req.url === '/down') {
      json(503, {});
      return;
    }
    if (req.url === '/slow') {
      setTimeout(() => json(200, {}), 1000);
      return;
    }
    if (rejectSession || !sessionValid || req.headers.authorization !== `Bearer ${validToken}`) {
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
      json(404, { error: { code: 'GENERAL_ERROR', messages: null } });
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
const isLogin = (r) => r.method === 'POST' && r.url.startsWith('/login');
const isRefresh = (r) => r.url === '/oauth2/token' && r.body.includes('grant_type=refresh_token');

test('login posts the form with its csrf and cookies, and keeps the token of the code', async () => {
  const client = newClient();
  await client.login();
  assert.equal(client.token, 'at1');
  assert.equal(client.isLoggedIn(), true);
  const login = requests.find(isLogin);
  assert.ok(login.url.includes('code_challenge_method=S256'));
  assert.equal(login.headers['content-type'], 'application/x-www-form-urlencoded;charset=UTF-8');
  const form = new URLSearchParams(login.body);
  assert.equal(form.get('username'), 'user@example.com');
  assert.equal(form.get('csrf'), 'csrf1');
  const token = new URLSearchParams(requests.at(-1).body);
  assert.equal(token.get('client_id'), 'ugfnsujd3384sshcjehaphlh3');
  assert.equal(token.get('redirect_uri'), 'https://monitoring.solaredge.com/mfe/auth/callback');
});

test('a wrong password (the form served again) throws and leaves no session', async () => {
  const client = newClient('wrong');
  await assert.rejects(client.login(), (error) => error.code === 'INVALID_CREDENTIALS');
  assert.equal(client.isLoggedIn(), false);
  assert.equal(count((r) => r.url === '/oauth2/token'), 0);
});

test('a redirect elsewhere (second factor) is LOGIN_REFUSED', async () => {
  const client = newClient('mfa');
  await assert.rejects(client.login(), (error) => error.code === 'LOGIN_REFUSED');
  assert.equal(client.isLoggedIn(), false);
});

test('an unexpected status (410) is LOGIN_REFUSED, not a wrong password', async () => {
  const client = newClient('gone');
  await assert.rejects(client.login(), (error) => error.code === 'LOGIN_REFUSED');
});

test('the first call logs in, with the app headers and the Bearer token', async () => {
  const client = newClient();
  const sites = await client.getSites();
  assert.deepEqual(sites, { 1: { id: 1, name: 'Home' } });
  const call = requests.at(-1);
  assert.equal(call.headers['user-agent'], SolarEdgeCloudClient.HEADERS['User-Agent']);
  assert.equal(call.headers['client-version'], '3.12');
  assert.equal(call.headers.authorization, 'Bearer at1');
  assert.equal(count(isLogin), 1);
});

test('an expired token is refreshed before the call, without a login', async () => {
  const client = newClient();
  await client.getSites();
  client._tokenExpiresAt = Date.now() - 1;
  await client.getSites();
  assert.equal(client.token, 'at2');
  assert.equal(count(isRefresh), 1);
  assert.equal(count(isLogin), 1);
});

test('a refresh token no longer accepted falls back to a login', async () => {
  const client = newClient();
  await client.getSites();
  client._tokenExpiresAt = Date.now() - 1;
  refreshValid = false;
  await client.getSites();
  assert.equal(count(isRefresh), 1);
  assert.equal(count(isLogin), 2);
  assert.equal(client._refreshToken, 'rt1');
});

test('a new refresh token is reported, and null once it is no longer accepted', async () => {
  const reported = [];
  const client = new SolarEdgeCloudClient({
    username: 'user@example.com', password: 'secret', onRefreshToken: (token) => reported.push(token),
  });
  await client.getSites();
  assert.equal(client.refreshToken, 'rt1');
  // a refresh keeps the refresh token: nothing to report
  client._tokenExpiresAt = 0;
  await client.getSites();
  assert.deepEqual(reported, ['rt1']);
  refreshValid = false;
  client._tokenExpiresAt = 0;
  await client.getSites();
  // dropped, then the login issued it again
  assert.deepEqual(reported, ['rt1', null, 'rt1']);
});

test('a kept refresh token renews without a password login', async () => {
  const client = newClient('wrong');
  client.useRefreshToken('rt1');
  const sites = await client.getSites();
  assert.deepEqual(sites, { 1: { id: 1, name: 'Home' } });
  assert.equal(count(isLogin), 0);
  assert.equal(count(isRefresh), 1);
  // a token the client already has is not replaced
  client.useRefreshToken('other');
  assert.equal(client.refreshToken, 'rt1');
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

test('a wrong password holds back automatic logins until the retry delay has passed', async () => {
  const client = newClient('wrong');
  await assert.rejects(client.getSites(), (error) => error.code === 'INVALID_CREDENTIALS');
  await assert.rejects(client.getSites(), (error) => error.code === 'INVALID_CREDENTIALS');
  assert.equal(count(isLogin), 1);
  // an explicit login (settings, pairing) still goes out, and doubles the delay
  await assert.rejects(client.login(), (error) => error.code === 'INVALID_CREDENTIALS');
  assert.equal(count(isLogin), 2);
  assert.equal(client._loginRetryDelay, 2 * SolarEdgeCloudClient.LOGIN_RETRY_MIN);
  client._loginBlockedUntil = 0;
  client.password = 'secret';
  await client.getSites();
  assert.equal(count(isLogin), 3);
  assert.equal(client._loginRetryDelay, 0);
});

test('a server error on the login holds back automatic logins as LOGIN_REFUSED', async () => {
  const client = newClient('locked');
  await assert.rejects(client.getSites(), (error) => error.code === 'LOGIN_REFUSED' && error.status === 500);
  await assert.rejects(client.getSites(), (error) => error.code === 'LOGIN_REFUSED');
  assert.equal(count(isLogin), 1);
  assert.equal(client._loginRetryDelay, SolarEdgeCloudClient.LOGIN_RETRY_MIN);
  assert.ok(client.backoffUntil > Date.now());
  // a wrong password after it is reported as such
  client.password = 'wrong';
  await assert.rejects(client.login(), (error) => error.code === 'INVALID_CREDENTIALS');
  await assert.rejects(client.getSites(), (error) => error.code === 'INVALID_CREDENTIALS');
  assert.equal(client._loginRetryDelay, 2 * SolarEdgeCloudClient.LOGIN_RETRY_MIN);
});

test('a 401 renews the token and retries the call once', async () => {
  const client = newClient();
  await client.getSites();
  sessionValid = false;
  const sites = await client.getSites();
  assert.deepEqual(sites, { 1: { id: 1, name: 'Home' } });
  assert.equal(count(isRefresh), 1);
  assert.equal(count(isLogin), 1);
});

test('a 401 right after the renewed token is a rejected login and drops the session', async () => {
  const client = newClient();
  await client.getSites();
  rejectSession = true;
  await assert.rejects(client.getSites(), (error) => error.code === 'INVALID_CREDENTIALS');
  assert.equal(client.isLoggedIn(), false);
  assert.equal(count(isRefresh), 1);
});

test('a token whose first answer is 401 holds back automatic logins, doubling per login', async () => {
  const client = newClient();
  rejectSession = true;
  await assert.rejects(client.getSites(), (error) => error.code === 'INVALID_CREDENTIALS');
  await assert.rejects(client.getSitePowerflow({ siteId: 1 }), (error) => error.code === 'INVALID_CREDENTIALS');
  assert.equal(count(isLogin), 1);
  assert.equal(client._loginRetryDelay, SolarEdgeCloudClient.LOGIN_RETRY_MIN);
  client._loginBlockedUntil = 0;
  // the next try renews with the refresh token: no password goes out again
  await assert.rejects(client.getSites(), (error) => error.code === 'INVALID_CREDENTIALS');
  assert.equal(count(isLogin), 1);
  assert.equal(count(isRefresh), 1);
  assert.equal(client._loginRetryDelay, 2 * SolarEdgeCloudClient.LOGIN_RETRY_MIN);
  rejectSession = false;
  client._loginBlockedUntil = 0;
  await client.getSites();
  assert.equal(client._loginRetryDelay, 0);
});

test('a late 401 does not drop a token from a later renewal', async () => {
  const client = newClient();
  await client.getSites();
  const realFetch = globalThis.fetch;
  // a renewal lands while this call is in flight with a stale token
  globalThis.fetch = async (url, opts) => {
    globalThis.fetch = realFetch;
    const res = await realFetch(url, { ...opts, headers: { ...opts.headers, Authorization: 'Bearer old' } });
    validToken = 'fresh';
    client.token = 'fresh';
    return res;
  };
  try {
    await client.getSites();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(client.token, 'fresh');
  assert.equal(count(isLogin), 1);
  assert.equal(count(isRefresh), 0);
});

test('an outage pauses the account; failures of one tick count once; a success resumes', async () => {
  const client = newClient();
  await client.login();
  const down = () => client.request({ url: 'https://monitoring.solaredge.com/down', errorText: 'x' });
  const started = Date.now();
  await Promise.all([down(), down()].map((p) => p.catch(() => {})));
  assert.equal(client._outages, 1);
  assert.ok(client.backoffUntil >= started + 2 * client.pollInterval);
  client.backoffUntil = 0;
  await down().catch(() => {});
  assert.equal(client._outages, 2);
  assert.ok(client.backoffUntil >= Date.now() + 3 * client.pollInterval);
  await client.getSites();
  assert.equal(client._outages, 0);
  assert.equal(client.backoffUntil, 0);
});

test('one failing endpoint while others answer is no outage', async () => {
  const client = newClient();
  await client.getSites();
  await client.request({ url: 'https://monitoring.solaredge.com/down', errorText: 'x' }).catch(() => {});
  assert.equal(client._outages, 0);
  assert.equal(client.backoffUntil, 0);
});

test('an API error code is no outage', async () => {
  const client = newClient();
  await assert.rejects(client.getSiteMeasurements({ siteId: 1, endDate: '2020-12-31' }), /GENERAL_ERROR/);
  assert.equal(client.backoffUntil, 0);
});

test('the deadline cuts a request short', async () => {
  const client = newClient();
  await client.login();
  client.deadline = Date.now() + 100;
  const started = Date.now();
  await assert.rejects(client.request({ url: 'https://monitoring.solaredge.com/slow', errorText: 'x' }), { name: 'TimeoutError' });
  assert.ok(Date.now() - started < 900);
});

test('the error code of a JSON error is the message', async () => {
  const client = newClient();
  await assert.rejects(client.getSiteMeasurements({ siteId: 1, endDate: '2020-12-31' }), /^Error: GENERAL_ERROR$/);
  const call = requests.find((r) => r.url.includes('/measurements'));
  assert.equal(call.url, '/services/m/so/dashboard/site/1/measurements?period=YEAR&measurement-unit=WATT_HOUR&end-date=2020-12-31');
});

test('a non-JSON error gives the status text', async () => {
  const client = newClient();
  await assert.rejects(client.request({ url: 'https://monitoring.solaredge.com/unknown', errorText: 'x' }), /^Error: Server Error$/);
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
  // send the client's monitoring.solaredge.com and login.solaredge.com calls to the local server
  const realFetch = globalThis.fetch;
  const local = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = (url, opts) => realFetch(String(url)
    .replace('https://monitoring.solaredge.com', local)
    .replace('https://login.solaredge.com', local), opts);

  let failed = 0;
  for (const { name, fn } of tests) {
    requests.length = 0;
    sessionValid = true;
    rejectSession = false;
    refreshValid = true;
    issued = 0;
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
