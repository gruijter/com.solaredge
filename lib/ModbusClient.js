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

const net = require('net');

const ModbusException = require('./ModbusException');

const MBAP_LENGTH = 7; // transactionId(2) protocolId(2) length(2) unitId(1)
const FC_READ_HOLDING_REGISTERS = 0x03;
const FC_READ_INPUT_REGISTERS = 0x04;
const FC_WRITE_SINGLE_REGISTER = 0x06;
const FC_WRITE_MULTIPLE_REGISTERS = 0x10;
const MAX_REGISTERS_PER_READ = 125; // hard limit of function code 0x03/0x04
const MAX_REGISTERS_PER_WRITE = 123; // hard limit of function code 0x10
const MAX_PDU_LENGTH = 253;

/** Mark an error as "could not reach the server at all", as opposed to a failed request. */
const connectError = (error) => Object.assign(error, { connectFailed: true });

/**
 * Minimal, dependency-free Modbus TCP client: read and write holding registers.
 * One transaction in flight at a time, so devices can share it (ModbusPool).
 */
module.exports = class ModbusClient {

  /**
   * @param {object} options
   * @param {string} options.host        IP address or hostname of the Modbus server
   * @param {number} [options.port=502]  TCP port
   * @param {number} [options.unitId=1]  Modbus unit/slave id
   * @param {number} [options.timeout]   Per-request timeout in ms
   * @param {function} [options.log]     Logger, called with debug messages
   */
  constructor({
    host, port = 502, unitId = 1, timeout = 5000, log,
  }) {
    this.host = host;
    this.port = Number(port) || 502;
    this.unitId = Number(unitId) || 1;
    this.timeout = Number(timeout) || 5000;
    this.log = typeof log === 'function' ? log : () => {};

    this.socket = null;
    this.connected = false;
    this.connecting = null;
    this.destroyed = false;
    this.transactionId = 0;
    this.pending = null; // { transactionId, functionCode, resolve, reject, timer }
    this.rxBuffer = Buffer.alloc(0);
    this.queue = Promise.resolve();
  }

  get id() {
    return `${this.host}:${this.port}#${this.unitId}`;
  }

  /** True when the error means the server could not be reached, not that one request failed. */
  static isConnectError(error) {
    return Boolean(error && error.connectFailed);
  }

  /** Open the socket, or return the in-flight/already-open connection. */
  async connect() {
    if (this.destroyed) throw connectError(Error('Modbus client is destroyed'));
    if (this.socket && !this.socket.destroyed && this.connected) return;
    if (this.connecting) {
      await this.connecting;
      return;
    }

    this.connecting = new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let settled = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(connectError(error));
      };

      // A replaced socket can still emit late events: they must not touch its successor.
      socket.setTimeout(this.timeout);
      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        socket.setTimeout(0); // per-request timers take over from here
        socket.setNoDelay(true);
        this.connected = true;
        this.log(`connected to ${this.id}`);
        resolve();
      });
      socket.once('timeout', () => fail(Error(`Connection to ${this.id} timed out`)));
      socket.on('error', (error) => {
        if (socket === this.socket) this.onSocketClosed(error);
        fail(error);
      });
      socket.once('close', () => {
        if (socket === this.socket) this.onSocketClosed(Error('Connection closed'));
      });
      socket.on('data', (chunk) => {
        if (socket === this.socket) this.onData(chunk);
      });

      this.socket = socket;
      this.connected = false;
      this.rxBuffer = Buffer.alloc(0);
      socket.connect({ host: this.host, port: this.port });
    })
      .finally(() => {
        this.connecting = null;
      });

    await this.connecting;
  }

  onSocketClosed(error) {
    this.connected = false;
    this.rxBuffer = Buffer.alloc(0);
    this.rejectPending(error);
  }

  rejectPending(error) {
    if (!this.pending) return;
    const { reject, timer } = this.pending;
    this.pending = null;
    clearTimeout(timer);
    reject(error);
  }

  /** The stream is no longer parseable: fail what is waiting and start over on a new socket. */
  onMalformed(reason) {
    this.log(`malformed reply from ${this.id}: ${reason}`);
    this.rejectPending(Error(`Malformed Modbus reply from ${this.id}: ${reason}`));
    this.disconnect();
  }

  onData(chunk) {
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);

    // A response is MBAP(7) + PDU, where the MBAP length field covers unitId + PDU.
    while (this.rxBuffer.length >= 6) {
      const length = this.rxBuffer.readUInt16BE(4);
      // unitId + function code at the very least, and never more than a whole PDU.
      if (length < 2 || length > MAX_PDU_LENGTH + 1) {
        this.onMalformed(`length field ${length}`);
        return;
      }
      const total = 6 + length;
      if (this.rxBuffer.length < total) return;

      const frame = this.rxBuffer.subarray(0, total);
      this.rxBuffer = this.rxBuffer.subarray(total);
      this.onFrame(frame);
    }
  }

  onFrame(frame) {
    const { pending } = this;
    if (!pending) return; // late reply to a request that already timed out

    const transactionId = frame.readUInt16BE(0);
    if (transactionId !== pending.transactionId) {
      this.log(`ignoring reply for transaction ${transactionId}, expected ${pending.transactionId}`);
      return;
    }

    const functionCode = frame.readUInt8(MBAP_LENGTH);
    if (functionCode & 0x80) {
      if (frame.length < MBAP_LENGTH + 2) {
        this.onMalformed('truncated exception');
        return;
      }
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(new ModbusException(frame.readUInt8(MBAP_LENGTH + 1)));
      return;
    }
    if (functionCode !== pending.functionCode) {
      this.onMalformed(`function code ${functionCode}, expected ${pending.functionCode}`);
      return;
    }

    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(Buffer.from(frame.subarray(MBAP_LENGTH + 1)));
  }

  /** Run `task` after every earlier request, however that one ended. */
  enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Read a block of 16-bit registers.
   * @param {number} address       First register address
   * @param {number} length        Number of registers, max 125
   * @param {number} functionCode  0x03 (holding) or 0x04 (input)
   * @returns {Promise<Buffer>}    Raw big-endian register bytes, 2 per register
   */
  async readRegisters(address, length, functionCode = FC_READ_HOLDING_REGISTERS) {
    if (length < 1 || length > MAX_REGISTERS_PER_READ) {
      throw Error(`Cannot read ${length} registers in one request, max is ${MAX_REGISTERS_PER_READ}`);
    }

    const payload = Buffer.alloc(4);
    payload.writeUInt16BE(address, 0);
    payload.writeUInt16BE(length, 2);

    const data = await this.enqueue(() => this.request(functionCode, payload));
    const byteCount = data.length ? data.readUInt8(0) : -1;
    if (byteCount !== length * 2 || data.length < 1 + byteCount) {
      throw Error(`Short reply reading ${length} registers at ${address} from ${this.id}`);
    }
    return data.subarray(1, 1 + byteCount);
  }

  /**
   * Write one 16-bit register with function code 0x06.
   * @param {number} address
   * @param {number} value  0..65535, or a negative number for a signed register
   */
  async writeRegister(address, value) {
    const word = value & 0xffff;
    const payload = Buffer.alloc(4);
    payload.writeUInt16BE(address, 0);
    payload.writeUInt16BE(word, 2);

    const data = await this.enqueue(() => this.request(FC_WRITE_SINGLE_REGISTER, payload));
    if (data.length < 4 || data.readUInt16BE(0) !== address || data.readUInt16BE(2) !== word) {
      throw Error(`Unexpected echo writing register ${address} on ${this.id}`);
    }
  }

  /**
   * Write consecutive 16-bit registers in one request with function code 0x10.
   * @param {number} address  First register address
   * @param {number[]} words  Register values, 0..65535 (negative numbers are stored as two's complement)
   */
  async writeRegisters(address, words) {
    if (words.length < 1 || words.length > MAX_REGISTERS_PER_WRITE) {
      throw Error(`Cannot write ${words.length} registers in one request, max is ${MAX_REGISTERS_PER_WRITE}`);
    }

    const payload = Buffer.alloc(5 + words.length * 2);
    payload.writeUInt16BE(address, 0);
    payload.writeUInt16BE(words.length, 2);
    payload.writeUInt8(words.length * 2, 4);
    words.forEach((word, i) => payload.writeUInt16BE(word & 0xffff, 5 + i * 2));

    const data = await this.enqueue(() => this.request(FC_WRITE_MULTIPLE_REGISTERS, payload));
    if (data.length < 4 || data.readUInt16BE(0) !== address || data.readUInt16BE(2) !== words.length) {
      throw Error(`Unexpected echo writing ${words.length} registers at ${address} on ${this.id}`);
    }
  }

  /** Send one request PDU and resolve with the reply's data, i.e. the PDU after its function code. */
  async request(functionCode, payload) {
    await this.connect();

    this.transactionId = (this.transactionId + 1) & 0xffff;
    const { transactionId } = this;

    const frame = Buffer.alloc(MBAP_LENGTH + 1 + payload.length);
    frame.writeUInt16BE(transactionId, 0);
    frame.writeUInt16BE(0x0000, 2); // protocol id
    frame.writeUInt16BE(2 + payload.length, 4); // unitId + function code + payload
    frame.writeUInt8(this.unitId, 6);
    frame.writeUInt8(functionCode, 7);
    payload.copy(frame, MBAP_LENGTH + 1);

    return new Promise((resolve, reject) => {
      // No `homey` here; cleared on reply, write error and socket close (destroy() closes it).
      // eslint-disable-next-line homey-app/global-timers
      const timer = setTimeout(() => {
        if (this.pending && this.pending.transactionId === transactionId) this.pending = null;
        // Out of sync: the next request starts on a new socket.
        this.disconnect();
        reject(Error(`Timeout on function ${functionCode} at ${payload.readUInt16BE(0)} from ${this.id}`));
      }, this.timeout);

      this.pending = {
        transactionId, functionCode, resolve, reject, timer,
      };

      this.socket.write(frame, (error) => {
        if (!error) return;
        if (this.pending && this.pending.transactionId === transactionId) this.pending = null;
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  /** Close the socket but keep the client reusable. */
  disconnect() {
    const { socket } = this;
    this.socket = null;
    this.connected = false;
    this.rxBuffer = Buffer.alloc(0);
    if (socket) socket.destroy();
  }

  /** Close the socket for good. */
  destroy() {
    this.destroyed = true;
    this.rejectPending(Error('Modbus client is destroyed'));
    this.disconnect();
  }

};

module.exports.ModbusException = ModbusException;
module.exports.FC_READ_HOLDING_REGISTERS = FC_READ_HOLDING_REGISTERS;
module.exports.FC_READ_INPUT_REGISTERS = FC_READ_INPUT_REGISTERS;
module.exports.MAX_REGISTERS_PER_READ = MAX_REGISTERS_PER_READ;
