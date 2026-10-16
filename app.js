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

const Homey = require('homey');
const SolarEdgeCloudClient = require('./lib/SolarEdgeCloudClient');
const ModbusPool = require('./lib/ModbusPool');
const capture = require('./lib/solarEdgeCapture');
const { DEFAULT_POLL_INTERVAL, POLL_EVENT, MODBUS_POLL_EVENT } = require('./lib/solarEdgeConstants');
const {
  PERIOD_MS, MARGIN_MS, learnCadence, judgesTick, tickPhase, adaptMargin, delayToNextTick,
} = require('./lib/solarEdgeTiming');

const clientId = ({ username, password }) => JSON.stringify([username, password]);

module.exports = class SolarEdgeApp extends Homey.App {

  async onInit() {
    this.clients = new Map();
    // per client: { timer, energyTimer, phaseMs, marginMs, cadenceMs, snapshots: Map(serial -> ms), judgePending }
    this.pollers = new Map();
    // the local Modbus devices on one inverter share its single Modbus TCP connection
    this.pool = new ModbusPool();
    this.registerFlowListeners();
    // users are asked to restart the app before a diagnostics report
    capture.arm('app start', { force: true });
    this.log('SolarEdge app initialized');
  }

  /**
   * The shared API client per account: one session for all devices of that account.
   * @returns {SolarEdgeCloudClient}
   */
  getClient({ username, password }) {
    const id = clientId({ username, password });
    if (!this.clients.has(id)) this.clients.set(id, this.newClient({ username, password }));
    return this.clients.get(id);
  }

  /** A client whose answers go to the log while capturing is armed (lib/solarEdgeCapture.js). */
  newClient({ username, password }) {
    const client = new SolarEdgeCloudClient({
      username,
      password,
      log: (...args) => this.log('[client]', ...args),
      error: (...args) => this.error('[client]', ...args),
    });
    return capture.wrap(client, (line) => this.log(line));
  }

  /**
   * Log in with a device's changed credentials and switch the device to them; throws when the login
   * fails. A new password for the same account moves all its devices along, so none keeps logging
   * in with the old one. Clients no device uses any more are dropped.
   */
  async changeCredentials({ device, oldSettings, newSettings }) {
    const credentials = { username: newSettings.username, password: newSettings.password };
    const id = clientId(credentials);
    const client = this.clients.get(id) || this.newClient(credentials);
    await client.login();
    this.clients.set(id, client);

    const devices = this.getDevices();
    const moving = [device];
    if (oldSettings.username === newSettings.username) {
      const oldId = clientId(oldSettings);
      moving.push(...devices.filter((other) => other !== device && clientId(other.getSettings()) === oldId));
    }
    for (const other of moving) {
      // setSettings does not call onSettings (SDK docs)
      // eslint-disable-next-line no-await-in-loop
      if (other !== device) await other.setSettings(credentials);
      other.connect(other === device ? newSettings : other.getSettings());
    }

    this.dropUnusedClients(devices);
  }

  /** Stop the ticks of, and forget, the clients none of `devices` uses. */
  dropUnusedClients(devices = this.getDevices()) {
    const inUse = new Set(devices.map((other) => other.client));
    for (const [key, unused] of this.clients) {
      if (inUse.has(unused)) continue;
      this.clients.delete(key);
      this.stopPolling(unused);
    }
  }

  /** A device's changed poll interval (s) holds for its whole account: all its devices follow. */
  async changePollInterval({ device, interval }) {
    for (const other of this.getDevices()) {
      // eslint-disable-next-line no-await-in-loop
      if (other !== device && other.client === device.client) await other.setSettings({ poll_interval: interval });
    }
    this.setPollInterval(device.client, interval);
  }

  getDevices() {
    return Object.values(this.homey.drivers.getDrivers()).flatMap((driver) => driver.getDevices());
  }

  registerFlowListeners() {
    // the Modbus devices listen for it (lib/modbus_device.js); the cloud is left to its own pace
    this.homey.flow.getActionCard('force_poll')
      .registerRunListener(async () => {
        this.homey.emit(MODBUS_POLL_EVENT);
        return true;
      });
    this.homey.flow.getActionCard('home-load-controller-set-state')
      .registerRunListener(async ({ device, state }) => {
        await device.triggerCapabilityListener('solaredge-home-load-controller-state', state);
      });
    this.homey.flow.getActionCard('evcharger-set-auto')
      .registerRunListener(async ({ device }) => device.setAutomatic());

    // Homey generates no conditions for custom capabilities; their declared `_changed`, `_true` and
    // `_false` triggers it runs itself (Flow docs), so the app never triggers those.
    const valueIs = { inverter_status: 'status', ev_charge_mode: 'mode', 'solaredge-home-load-controller-state': 'state' };
    for (const [capability, arg] of Object.entries(valueIs)) {
      this.homey.flow.getConditionCard(`${capability}_is`)
        .registerRunListener(async (args) => args.device.hasCapability(capability) && args.device.getCapabilityValue(capability) === args[arg]);
    }
    this.homey.flow.getConditionCard('ev_solar_charging_is')
      .registerRunListener(async ({ device }) => device.hasCapability('ev_solar_charging') && device.getCapabilityValue('ev_solar_charging') === true);
  }

  /**
   * Per account a fast tick (the real-time powerflow, every poll_interval) and an energy tick once
   * per PERIOD_MS, placed just after the inverters' new data (lib/solarEdgeTiming.js). All devices of
   * the account ask at the same moment, so their identical calls go out once
   * (SolarEdgeCloudClient#request). Starts the account's ticks unless they already run.
   * @param {SolarEdgeCloudClient} client
   * @param {number} [interval] seconds
   */
  startPolling(client, interval) {
    if (!this.pollers.has(client)) this.setPollInterval(client, interval);
  }

  setPollInterval(client, interval) {
    const seconds = Number(interval) || DEFAULT_POLL_INTERVAL;
    const previous = this.pollers.get(client);
    if (previous) this.homey.clearInterval(previous.timer);
    client.pollInterval = seconds * 1000;
    const poller = previous || {
      phaseMs: 0, marginMs: MARGIN_MS, snapshots: new Map(), judgePending: false,
    };
    poller.timer = this.homey.setInterval(() => this.tick(client), client.pollInterval);
    this.pollers.set(client, poller);
    if (!previous) this.scheduleEnergyTick(client);
    this.log(`polling an account every ${seconds} seconds`);
  }

  stopPolling(client) {
    const poller = this.pollers.get(client);
    if (poller) {
      this.homey.clearInterval(poller.timer);
      this.homey.clearTimeout(poller.energyTimer);
    }
    this.pollers.delete(client);
  }

  /** Emit a tick for the account's devices; skipped while the client backs off after failures. */
  tick(client, { energy = false } = {}) {
    if (Date.now() < client.backoffUntil) return;
    this.homey.emit(POLL_EVENT, client, { energy });
  }

  scheduleEnergyTick(client) {
    const poller = this.pollers.get(client);
    if (!poller) return;
    this.homey.clearTimeout(poller.energyTimer);
    poller.energyTimer = this.homey.setTimeout(() => {
      poller.judgePending = true;
      this.tick(client, { energy: true });
      this.scheduleEnergyTick(client);
    }, delayToNextTick(Date.now(), poller.phaseMs));
  }

  /**
   * An inverter's latest measurement (getInvertersInformation lastMeasurement, epoch ms): the
   * account's energy tick follows it. A tick that found the old one
   * again while a new one was due came too early.
   */
  noteSnapshot(client, serial, at) {
    const poller = this.pollers.get(client);
    if (!poller || !Number.isFinite(at)) return;
    const previous = poller.snapshots.get(serial);
    poller.snapshots.set(serial, at);
    if (previous && at > previous) poller.cadenceMs = learnCadence(poller.cadenceMs, at - previous);
    if (poller.judgePending && previous && judgesTick({
      previousMs: previous, atMs: at, nowMs: Date.now(), cadenceMs: poller.cadenceMs,
    })) {
      poller.judgePending = false;
      const margin = adaptMargin(poller.marginMs, at > previous);
      if (margin !== poller.marginMs) {
        this.log(`energy tick margin ${Math.round(poller.marginMs / 1000)}s -> ${Math.round(margin / 1000)}s (${at > previous ? 'new' : 'no new'} inverter data on the last tick)`);
        poller.marginMs = margin;
      }
    }
    const phase = tickPhase([...poller.snapshots.values()], poller.marginMs);
    if (phase === poller.phaseMs) return;
    poller.phaseMs = phase;
    this.log(`energy tick moved to ${Math.round(phase / 1000)}s after each ${PERIOD_MS / 60000}-minute mark, right after the inverter data`);
    this.scheduleEnergyTick(client);
  }

  /** The account's upload interval in ms (learnCadence); undefined before an inverter's second snapshot. */
  uploadCadence(client) {
    return this.pollers.get(client)?.cadenceMs;
  }

  async onUninit() {
    // the pool is left to the devices: their onUninit still hands control back through it
    for (const client of [...this.pollers.keys()]) this.stopPolling(client);
  }

};
