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

const net = require('node:net');
const Homey = require('homey');
const ModbusClient = require('./ModbusClient');
const ModbusScanner = require('./ModbusScanner');
const ModbusDevice = require('./modbus_device');
const pointMap = require('./solarEdgePointMap');

/*
 * Pairing of the local Modbus TCP drivers, after com.solarwatt's CommonDriver. The address is looked
 * up (mDNS, else a scan of Homey's subnet) and filled in; the user confirms or corrects it, then
 * picks from the units found there: one inverter, or each meter or battery behind it.
 */

const DEFAULT_POLL_INTERVAL = 5; // seconds

/** Pairing must answer well inside Homey's 30s budget, so probes are kept short. */
const PAIR_TIMEOUT = 4000;

module.exports = class ModbusDriver extends Homey.Driver {

  async onInit() {
    this.definition = pointMap[this.id];
    this.log(`${this.id} driver has been initialized`);
  }

  /** manual (address) -> list_devices (the units found there) -> add_devices. */
  onPair(session) {
    let found = [];
    // started right away, so the result is ready when the view asks for it
    const discovery = this.discover();
    session.setHandler('discover', () => discovery);
    session.setHandler('manual_fields', async () => ({ port: this.definition.port, unitId: this.definition.unitId }));
    session.setHandler('manual_connect', async (data) => {
      found = await this.findDevices(data);
      return found.length;
    });
    session.setHandler('list_devices', async () => found);
  }

  /**
   * Endpoints where this driver finds something to pair, the most likely first: mDNS
   * (_solaredge-modbus._tcp, as Home Assistant), else every open driver port on Homey's /24, each
   * checked with the driver's own pairing reads. Never rejects.
   * @returns {Promise<Array<{ host: string, port: number, unitId: number, count: number }>>}
   */
  async discover() {
    try {
      const started = Date.now();
      let source = 'mDNS';
      let candidates = this.mdnsCandidates();
      if (candidates.length === 0) {
        source = 'scan';
        candidates = await this.scanCandidates();
      }
      const byHost = new Map();
      for (const endpoint of candidates) byHost.set(endpoint.host, [...(byHost.get(endpoint.host) || []), endpoint]);
      // hosts at once, but a host's ports one after another: it serves one Modbus connection at a
      // time. One entry per host, on the first port that answered (point map `ports` order).
      const checked = await Promise.all([...byHost.values()].map(async (endpoints) => {
        for (const endpoint of endpoints) {
          // eslint-disable-next-line no-await-in-loop
          const devices = await this.findDevicesAt(endpoint, { discovering: true }).catch(() => []);
          if (devices.length) return { ...endpoint, count: devices.length };
        }
        return null;
      }));
      const result = checked.filter(Boolean);
      this.log(`[pair] ${source}: ${candidates.length} candidate(s), ${result.length} found in ${Date.now() - started} ms`,
        result.map((endpoint) => `${endpoint.host}:${endpoint.port}#${endpoint.unitId}`).join(', '));
      return result;
    } catch (error) {
      this.error('discovery failed:', error.message);
      return [];
    }
  }

  /** What the mDNS strategy sees, for drivers on the inverter's Modbus server (point map `mdns`). */
  mdnsCandidates() {
    if (!this.definition.mdns) return [];
    let results = [];
    try {
      results = Object.values(this.homey.discovery.getStrategy('solaredge-modbus').getDiscoveryResults());
    } catch (error) {
      this.error('mDNS unavailable:', error.message);
    }
    return results.filter((result) => result.address).map((result) => {
      const txt = result.txt || {};
      return {
        host: result.address,
        port: Number(result.port) || this.definition.port,
        unitId: Number(txt.MODBUS_ID ?? txt.modbus_id) || this.definition.unitId,
      };
    });
  }

  /**
   * Open driver ports on Homey's /24 (IPv4 only). A host the app is already connected to is not
   * probed (a second connection could drop the devices'); its connection is checked instead.
   */
  async scanCandidates() {
    const localIp = String(await this.homey.cloud.getLocalAddress()).split(':')[0];
    if (!net.isIPv4(localIp)) {
      this.log(`[pair] no scan: local address ${localIp} is not IPv4`);
      return [];
    }
    const ports = this.scanPorts();
    const inUse = this.homey.app.pool.endpoints();
    const open = await ModbusScanner.scan(localIp, ports, { skipHosts: inUse.map(({ host }) => host) });
    return [
      ...inUse.filter(({ port }) => ports.includes(port)),
      ...open.map(({ host, port }) => ({ host, port, unitId: this.definition.unitId })),
    ];
  }

  scanPorts() {
    return this.definition.ports || [this.definition.port];
  }

  normalizeEndpoint({ host, port, unitId }) {
    const cleanHost = String(host || '').trim();
    if (!cleanHost) throw Error(this.homey.__('errors.hostRequired'));
    return {
      host: cleanHost,
      port: Number(port) || this.definition.port,
      unitId: Number(unitId) || this.definition.unitId,
    };
  }

  /**
   * Read `blocks` into one address-keyed map, in order (the client keeps `readGapMs` between
   * them); an `optional` block that fails is left out.
   * @returns {Promise<Map<number, number>>}
   */
  async read(client, blocks) {
    const registers = new Map();
    for (const block of blocks) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const data = await client.readRegisters(block.start, block.count);
        for (let i = 0; i < block.count; i += 1) registers.set(block.start + i, data.readUInt16BE(i * 2));
      } catch (error) {
        if (!block.optional || ModbusClient.isConnectError(error)) throw error;
        this.log(`[pair] optional block at ${block.start} failed: ${error.message}`);
      }
    }
    return registers;
  }

  /**
   * The devices this driver can add at an address, ready for list_devices; throws when nothing
   * (suitable) answers there. When the port does not connect, the driver's other standard port
   * (point map `ports`) is tried too.
   */
  async findDevices(fields) {
    const endpoint = this.normalizeEndpoint(fields);
    const ports = [endpoint.port, ...(this.definition.ports || []).filter((port) => port !== endpoint.port)];
    for (const [index, port] of ports.entries()) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await this.findDevicesAt({ ...endpoint, port });
      } catch (error) {
        const last = index === ports.length - 1;
        this.log(`[pair] ${endpoint.host}:${port}#${endpoint.unitId}: ${error.message}`);
        if (!ModbusClient.isConnectError(error) || last) {
          if (error.unitsMissing) throw error;
          throw Error(`${this.homey.__('errors.modbusProbeFailed')} (${error.message})`);
        }
      }
    }
    return [];
  }

  /**
   * findDevices() on one endpoint; a ModbusClient error passes through as it is. Over the pooled
   * connection, so pairing shares the one of a device already paired on that server.
   * @param {object} [options] { discovering }: only on a server the point map's `discoverable` accepts
   */
  async findDevicesAt(endpoint, { discovering = false } = {}) {
    const { pool } = this.homey.app;
    const client = pool.acquire({
      ...endpoint, timeout: PAIR_TIMEOUT, gapMs: this.definition.readGapMs, log: (message) => this.log(message),
    });
    const read = (blocks) => this.read(client, blocks);

    const devices = [];
    try {
      if (discovering && this.definition.discoverable && !(await this.definition.discoverable(read))) return [];
      const units = await this.definition.findUnits(read);
      for (const { base } of units) {
        // eslint-disable-next-line no-await-in-loop
        const registers = await read(this.definition.identityBlocks(base));
        devices.push(this.buildDevice({ endpoint, base, registers }));
      }
    } finally {
      pool.release(endpoint);
    }

    if (devices.length === 0) throw Object.assign(Error(this.homey.__('errors.modbusNoUnits')), { unitsMissing: true });
    return devices;
  }

  /** The Homey device object for the unit at `base`. */
  buildDevice({ endpoint, base, registers }) {
    const identity = this.definition.identity(registers, base);
    const name = this.manifest.name[this.homey.i18n.getLanguage()] || this.manifest.name.en;
    return {
      name: `${name} ${identity.serialNumber || endpoint.host}`,
      data: { id: this.definition.dataId(registers, base) || `${endpoint.host}-${base}` },
      store: { base },
      settings: {
        ...endpoint,
        pollInterval: DEFAULT_POLL_INTERVAL,
        ...ModbusDevice.identitySettings(identity, this.manifest),
      },
    };
  }

};
