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
const ModbusClient = require('./ModbusClient');
const DeviceMigrator = require('./DeviceMigrator');
const registerCapture = require('./registerCapture');
const pointMap = require('./solarEdgePointMap');

/*
 * The local Modbus TCP devices, after com.solarwatt's CommonDevice (no mDNS; controls only as the
 * point map's `controls`). Capabilities come from lib/solarEdgePointMap.js.
 */

const DEFAULT_POLL_INTERVAL = 5; // seconds
const REQUEST_TIMEOUT = 5000;

/** An optional block is dropped after this many consecutive failures. */
const OPTIONAL_BLOCK_RETRIES = 3;
/** Consecutive failed polls before the device is marked unavailable. */
const FAILURES_BEFORE_UNAVAILABLE = 3;
/** Re-read this long after a write, so the tile shows what the device actually did. */
const POLL_AFTER_WRITE = 3000;

module.exports = class ModbusDevice extends Homey.Device {

  async onInit() {
    if (!this.definition) throw Error(`No register map for driver ${this.driver.id}`);

    this.failures = 0;
    this.polling = false;
    this.identityRead = false;
    this.detectionDone = false;
    this.unmappedLogged = new Set();

    // per device: the failure counts must not leak into the shared map
    this.blocks = this.definition.blocks(this.base).map((block) => ({ ...block, failures: 0 }));
    this.armCapture('device start');

    const migrated = await this.migrate();
    await this.applyCapabilityOptions({ force: migrated });
    this.registerControls();
    await this.connect();
    await this.runDetection();
    this.startPolling();

    this.log(`${this.getName()} has been initialized`);
  }

  get definition() {
    return pointMap[this.driver.id];
  }

  /** Register offset of this meter or battery from the first one (pairing, store `base`). */
  get base() {
    return Number(this.getStoreValue('base')) || 0;
  }

  // --- connection ------------------------------------------------------------------------

  get endpoint() {
    const settings = this.getSettings();
    return {
      host: settings.host,
      port: Number(settings.port) || this.definition.port,
      unitId: Number(settings.unitId) || this.definition.unitId,
    };
  }

  /** Take a client from the app-wide pool for the address currently in settings. */
  async connect() {
    const { endpoint } = this;
    if (!endpoint.host) {
      await this.setUnavailable(this.homey.__('errors.hostMissing'));
      return;
    }

    this.release();
    this.client = this.homey.app.pool.acquire({
      ...endpoint,
      timeout: REQUEST_TIMEOUT,
      log: (message) => this.log(message),
    });
    this.connected = endpoint;
  }

  /** Hand the pooled client back, if we hold one. */
  release() {
    if (!this.connected) return;
    this.homey.app.pool.release(this.connected);
    this.connected = null;
    this.client = null;
  }

  // --- polling ---------------------------------------------------------------------------

  startPolling() {
    this.stopPolling();
    const seconds = Number(this.getSettings().pollInterval) || DEFAULT_POLL_INTERVAL;
    this.pollInterval = this.homey.setInterval(() => {
      this.poll().catch((error) => this.error(error));
    }, seconds * 1000);
    this.poll().catch((error) => this.error(error));
  }

  stopPolling() {
    if (!this.pollInterval) return;
    this.homey.clearInterval(this.pollInterval);
    this.pollInterval = null;
  }

  async poll() {
    if (this.polling || !this.client) return;
    this.polling = true;

    try {
      const registers = await this.readBlocks(this.blocks);
      if (registers.size === 0) throw Error(this.homey.__('errors.modbusNoData'));

      this.failures = 0;
      if (!this.getAvailable()) await this.setAvailable();
      await this.handleData(registers);
      await this.reapplyControls(registers);
      this.captureRegisters('Poll', registers, {
        values: Object.fromEntries(this.getCapabilities().map((capability) => [capability, this.getCapabilityValue(capability)])),
      });

      if (!this.identityRead) await this.readIdentity();
      // only when the device was unreachable during onInit
      if (!this.detectionDone) await this.runDetection();
    } catch (error) {
      this.failures += 1;
      this.error(`poll ${this.failures} failed:`, error.message);
      if (this.failures >= FAILURES_BEFORE_UNAVAILABLE) {
        await this.setUnavailable(`${this.homey.__('errors.modbusUnreachable')} ${error.message}`)
          .catch((setError) => this.error(setError));
      }
    } finally {
      this.polling = false;
    }
  }

  /** Wait `ms` between two requests, for servers that need it (point map `readGapMs`). */
  pause(ms) {
    return new Promise((resolve) => {
      this.homey.setTimeout(resolve, ms);
    });
  }

  /**
   * Read every block into one address-keyed map. A failing block only loses its own registers;
   * an `optional` one is no longer read after OPTIONAL_BLOCK_RETRIES failures.
   * @returns {Promise<Map<number, number>>}
   */
  async readBlocks(blocks) {
    const registers = new Map();
    const failed = [];
    const gap = this.definition.readGapMs || 0;

    for (const [index, block] of blocks.entries()) {
      if (block.disabled) continue;
      // only for what detect() found, e.g. the inverter's dynamic power limit
      if (block.when && !block.when(this.detected)) continue;
      try {
        // sequential: one transaction at a time per server
        // eslint-disable-next-line no-await-in-loop
        if (gap && index > 0) await this.pause(gap);
        // eslint-disable-next-line no-await-in-loop
        const data = await this.client.readRegisters(block.start, block.count);
        for (let i = 0; i < block.count; i += 1) {
          registers.set(block.start + i, data.readUInt16BE(i * 2));
        }
        block.failures = 0;
      } catch (error) {
        this.log(`block at ${block.start} failed: ${error.message}`);
        // unreachable: further blocks would only wait out their own timeouts
        if (ModbusClient.isConnectError(error)) break;
        failed.push(block);
      }
    }

    // A failure counts against an optional block only while the rest of the device answers.
    if (registers.size > 0) {
      for (const block of failed) {
        block.failures += 1;
        if (block.optional && block.failures >= OPTIONAL_BLOCK_RETRIES) {
          block.disabled = true;
          this.log(`optional block at ${block.start} not supported, no longer polling it`);
        }
      }
    }

    return registers;
  }

  /** Log identity, detection and the first poll again, see registerCapture. */
  armCapture(reason) {
    this.captureReason = reason;
    this.captured = new Set();
  }

  /** Log one kind of read (Identity, Detection, Poll) once per armCapture. */
  captureRegisters(kind, registers, extra) {
    if (!this.captureReason || this.captured.has(kind)) return;
    this.captured.add(kind);
    registerCapture.record(`${this.driver.id.replace(/[^A-Za-z]/g, '')}${kind}`, {
      reason: this.captureReason,
      version: this.homey.manifest.version,
      base: this.base,
      registers: registerCapture.toRuns(registers),
      ...extra,
    }, (line) => this.log(line));
  }

  /** Read model/serial/firmware once and mirror them into the device settings page. */
  async readIdentity() {
    try {
      const registers = await this.readBlocks(
        this.definition.identityBlocks(this.base).map((block) => ({ ...block, failures: 0 })),
      );
      const identity = this.definition.identity(registers, this.base);
      this.captureRegisters('Identity', registers, { identity });
      if (!identity.serialNumber && !identity.model) throw Error(this.homey.__('errors.modbusNoData'));

      await this.setSettings(ModbusDevice.identitySettings(identity, this.driver.manifest));
      this.identityRead = true;
    } catch (error) {
      this.error('could not read device identity:', error.message);
    }
  }

  /**
   * The settings-page fields for an identity read, with the driver's own extras: only the keys the
   * driver has as a setting.
   */
  static identitySettings(identity, driverManifest) {
    const settings = {
      deviceModel: identity.model || '',
      deviceSn: identity.serialNumber || '',
      manufacturer: identity.manufacturer || '',
      firmware: identity.firmware || '',
      ...Object.fromEntries(Object.entries(identity.settings || {}).map(([key, value]) => [key, value || ''])),
    };
    const known = new Set((driverManifest.settings || [])
      .flatMap((setting) => [setting, ...(setting.children || [])])
      .map((setting) => setting.id));
    return Object.fromEntries(Object.entries(settings).filter(([key]) => known.has(key)));
  }

  async handleData(registers) {
    for (const [capability, decode] of Object.entries(this.definition.capabilities)) {
      // eslint-disable-next-line no-await-in-loop
      await this.setCapability(capability, decode(registers, this));
    }
  }

  // --- controls --------------------------------------------------------------------------

  /** The point map's controls whose capability this device carries. */
  get controls() {
    return (this.definition.controls || []).filter((control) => this.hasCapability(control.capability));
  }

  /** A listener per control, once each (detection can add one later); a rejection is shown to the user. */
  registerControls() {
    if (!this.listening) this.listening = new Set();
    for (const control of this.controls) {
      if (this.listening.has(control.capability)) continue;
      this.listening.add(control.capability);
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      this.registerCapabilityListener(control.capability, (value) => this.runControl(control, value));
    }
  }

  async runControl(control, value) {
    this.log('control', control.capability, value);
    if (!this.client) throw Error(this.homey.__('errors.hostMissing'));
    try {
      await control.write({ client: this.client, device: this, value });
    } catch (error) {
      this.error('control failed:', error.message);
      if (error.refusal) throw error; // the device's own answer, already worded for the user
      throw Error(`${this.homey.__('errors.modbusWriteFailed')} ${error.message}`);
    }
    this.homey.setTimeout(() => {
      this.poll().catch((error) => this.error(error));
    }, POLL_AFTER_WRITE);
  }

  /** Write again what the device lost, e.g. a limit an inverter restart reset (control `reapply`). */
  async reapplyControls(registers) {
    for (const control of this.controls) {
      if (!control.reapply) continue;
      // eslint-disable-next-line no-await-in-loop
      await control.reapply({ client: this.client, device: this, regs: registers })
        .catch((error) => this.error('reapply failed:', error.message));
    }
  }

  // --- capabilities ----------------------------------------------------------------------

  /**
   * The capabilities this device should carry, in tile order: the register map's, minus what
   * `unsupported()` drops for this unit.
   */
  capabilityList() {
    const all = Object.keys(this.definition.capabilities);
    if (!this.definition.unsupported) return all;
    const drop = this.definition.unsupported(this.detected);
    return all.filter((capability) => !drop.includes(capability));
  }

  /** What detect() last concluded about this unit. `{}` means nothing is known yet. */
  get detected() {
    return this.getStoreValue('detected') || {};
  }

  /**
   * Work out what this unit can serve, once per (re)start: re-deciding per poll would only churn
   * capabilities on an odd read.
   */
  async runDetection() {
    if (this.detectionDone || !this.client) return;
    if (!this.definition.detect) {
      this.detectionDone = true;
      return;
    }

    const blocks = this.definition.detectBlocks(this.base).map((block) => ({ ...block, failures: 0 }));
    const registers = await this.readBlocks(blocks).catch((error) => {
      this.error('detection read failed:', error.message);
      return new Map();
    });
    // unreachable: keep the stored verdict, retry after the first good poll
    if (registers.size === 0) return;

    this.detectionDone = true;
    // merged: a fact detect() could not read this time keeps its stored value
    const previous = this.detected;
    const detected = { ...previous, ...this.definition.detect(registers, previous, this.base) };
    this.captureRegisters('Detection', registers, { previous, detected });
    await this.showDetectedSettings(detected);

    const keys = new Set([...Object.keys(detected), ...Object.keys(previous)]);
    if (![...keys].some((key) => detected[key] !== previous[key])) return;

    this.log('device detection changed:', JSON.stringify(previous), '->', JSON.stringify(detected));
    await this.setStoreValue('detected', detected);
    const migrated = await this.migrate();
    await this.applyCapabilityOptions({ force: migrated });
    // a capability detection added (target_power after the rated power) needs its listener
    this.registerControls();
  }

  /** Mirror what detect() found into the settings page (point map `detectedSettings`), when it differs. */
  async showDetectedSettings(detected) {
    if (!this.definition.detectedSettings) return;
    const known = new Set((this.driver.manifest.settings || [])
      .flatMap((setting) => [setting, ...(setting.children || [])])
      .map((setting) => setting.id));
    const changed = Object.fromEntries(Object.entries(this.definition.detectedSettings(detected, this))
      .filter(([key, value]) => known.has(key) && this.getSetting(key) !== value));
    if (Object.keys(changed).length) await this.setSettings(changed).catch((error) => this.error(error));
  }

  /**
   * Ranges that depend on the unit, e.g. a limit up to its rated power.
   * @param {object} [settings] { force }: write them unread, after a migration rebuilt capabilities
   */
  async applyCapabilityOptions({ force = false } = {}) {
    if (!this.definition.capabilityOptions) return;
    await DeviceMigrator.syncCapabilityOptions(this, this.definition.capabilityOptions(this.detected), { force });
  }

  /** Bring a paired device's capabilities, and their order, in line with capabilityList(). */
  async migrate() {
    return DeviceMigrator.migrateCapabilities(this, this.capabilityList());
  }

  /**
   * `undefined`: not read (failed block, absent register) - the tile keeps its value.
   * `null`: read, but no value right now - the tile is cleared.
   */
  async setCapability(capability, value) {
    if (!this.hasCapability(capability)) return;
    if (value === undefined) {
      this.logUnmapped(capability);
      return;
    }
    if (typeof value === 'number' && Number.isNaN(value)) return;

    await this.setCapabilityValue(capability, value)
      .catch((error) => this.error(error, capability, value));
  }

  // No trigger() for '<capability>_changed' cards: Homey runs them itself, also for
  // sub-capabilities (confirmed live in com.foxess 2026-10-04; a trigger() made flows run twice).

  /** Log once per start that a capability's registers never arrived. */
  logUnmapped(capability) {
    if (this.unmappedLogged.has(capability)) return;
    this.unmappedLogged.add(capability);
    this.log(`no value for '${capability}' - its registers were not returned by this device`);
  }

  // --- lifecycle -------------------------------------------------------------------------

  async onSettings({ changedKeys }) {
    if (changedKeys.some((key) => ['host', 'port', 'unitId'].includes(key))) {
      // getSettings() still returns the old values inside this handler
      this.homey.setTimeout(() => {
        this.connect()
          .then(() => this.startPolling())
          .catch((error) => this.error(error));
      }, 1000);
    } else if (changedKeys.includes('pollInterval')) {
      this.homey.setTimeout(() => this.startPolling(), 1000);
    }
  }

  onDeleted() {
    this.stopPolling();
    this.release();
    this.log('device was deleted', this.getName());
  }

  async onUninit() {
    this.stopPolling();
    this.release();
  }

};
