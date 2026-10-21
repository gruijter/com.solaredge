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

// A developer script, not app code: it reports to the console and sets an exit status.
/* eslint-disable no-console, no-process-exit, homey-app/global-timers */

/*
 * ModbusClient against a scripted fake Modbus TCP server, run with `npm test`.
 *
 * Covers what a live device rarely shows on demand: exception replies, silence, garbage on
 * the wire and a socket that dies mid-request. The garbage case is the important one - a
 * reply the parser cannot frame used to throw inside the socket's 'data' handler, which
 * takes the whole app down.
 */

const net = require('net');
const assert = require('assert');
const ModbusClient = require('../lib/ModbusClient');

/** Start a server whose reply to each request frame is decided by `handler(frame, socket)`. */
const startServer = (handler) => new Promise((resolve) => {
  const server = net.createServer((socket) => {
    socket.on('data', (frame) => handler(frame, socket));
    socket.on('error', () => {});
  });
  server.listen(0, '127.0.0.1', () => resolve(server));
});

/** Build a reply frame for `request`, carrying `pdu` (function code first). */
const reply = (request, pdu) => {
  const frame = Buffer.alloc(7 + pdu.length);
  request.copy(frame, 0, 0, 4); // transaction + protocol id
  frame.writeUInt16BE(1 + pdu.length, 4);
  frame.writeUInt8(request.readUInt8(6), 6);
  pdu.copy(frame, 7);
  return frame;
};

/** A well-behaved server: register n holds n & 0xffff, writes are echoed. */
const goodServer = (frame, socket) => {
  const fc = frame.readUInt8(7);
  const address = frame.readUInt16BE(8);
  if (fc === 0x03) {
    const count = frame.readUInt16BE(10);
    if (address >= 60000) {
      socket.write(reply(frame, Buffer.from([0x83, 0x02])));
      return;
    }
    const pdu = Buffer.alloc(2 + count * 2);
    pdu.writeUInt8(0x03, 0);
    pdu.writeUInt8(count * 2, 1);
    for (let i = 0; i < count; i += 1) pdu.writeUInt16BE((address + i) & 0xffff, 2 + i * 2);
    socket.write(reply(frame, pdu));
  } else if (fc === 0x06 || fc === 0x10) {
    socket.write(reply(frame, frame.subarray(7, 12)));
  }
};

const tests = {
  'reads a block': async function() {
    const server = await startServer(goodServer);
    const client = new ModbusClient({ host: '127.0.0.1', port: server.address().port, timeout: 500 });
    try {
      const data = await client.readRegisters(100, 3);
      assert.deepStrictEqual([data.readUInt16BE(0), data.readUInt16BE(2), data.readUInt16BE(4)], [100, 101, 102]);
    } finally {
      client.destroy();
      server.close();
    }
  },

  'turns an exception reply into a ModbusException': async function() {
    const server = await startServer(goodServer);
    const client = new ModbusClient({ host: '127.0.0.1', port: server.address().port, timeout: 500 });
    try {
      await assert.rejects(client.readRegisters(60000, 1), (error) => error instanceof ModbusClient.ModbusException && error.code === 2);
      // and the connection is still usable afterwards
      assert.strictEqual((await client.readRegisters(7, 1)).readUInt16BE(0), 7);
    } finally {
      client.destroy();
      server.close();
    }
  },

  'writes a single register and checks the echo': async function() {
    const server = await startServer(goodServer);
    const client = new ModbusClient({ host: '127.0.0.1', port: server.address().port, timeout: 500 });
    try {
      await client.writeRegister(0x4001, 2);
      await client.writeRegisters(46001, [7, 30, 0xffff, -500]);
    } finally {
      client.destroy();
      server.close();
    }
  },

  'times out on silence, then recovers on a new socket': async function() {
    let silent = true;
    const server = await startServer((frame, socket) => (silent ? null : goodServer(frame, socket)));
    const client = new ModbusClient({ host: '127.0.0.1', port: server.address().port, timeout: 200 });
    try {
      await assert.rejects(client.readRegisters(1, 1), (error) => /Timeout/.test(error.message) && !ModbusClient.isConnectError(error));
      silent = false;
      assert.strictEqual((await client.readRegisters(5, 1)).readUInt16BE(0), 5);
    } finally {
      client.destroy();
      server.close();
    }
  },

  'survives garbage on the wire': async function() {
    let garbage = true;
    const server = await startServer((frame, socket) => {
      if (!garbage) {
        goodServer(frame, socket);
        return;
      }
      // An MBAP header whose length field claims an empty PDU: unparseable.
      const bad = Buffer.from(frame.subarray(0, 7));
      bad.writeUInt16BE(0, 4);
      socket.write(bad);
    });
    const client = new ModbusClient({ host: '127.0.0.1', port: server.address().port, timeout: 500 });
    try {
      await assert.rejects(client.readRegisters(1, 1), /Malformed/);
      garbage = false;
      assert.strictEqual((await client.readRegisters(9, 1)).readUInt16BE(0), 9);
    } finally {
      client.destroy();
      server.close();
    }
  },

  'rejects a reply for another function code': async function() {
    const server = await startServer((frame, socket) => socket.write(reply(frame, Buffer.from([0x04, 0x02, 0x00, 0x01]))));
    const client = new ModbusClient({ host: '127.0.0.1', port: server.address().port, timeout: 500 });
    try {
      await assert.rejects(client.readRegisters(1, 1), /Malformed/);
    } finally {
      client.destroy();
      server.close();
    }
  },

  'rejects a pending request when the socket dies': async function() {
    const server = await startServer((frame, socket) => socket.destroy());
    const client = new ModbusClient({ host: '127.0.0.1', port: server.address().port, timeout: 2000 });
    try {
      const started = Date.now();
      await assert.rejects(client.readRegisters(1, 1));
      assert.ok(Date.now() - started < 1000, 'should fail on close, not wait for the timeout');
    } finally {
      client.destroy();
      server.close();
    }
  },

  'marks an unreachable server as a connect error': async function() {
    const server = await startServer(goodServer);
    const { port } = server.address();
    await new Promise((resolve) => {
      server.close(resolve);
    });
    const client = new ModbusClient({ host: '127.0.0.1', port, timeout: 500 });
    try {
      await assert.rejects(client.readRegisters(1, 1), (error) => ModbusClient.isConnectError(error));
    } finally {
      client.destroy();
    }
  },

  'settles a connect that a disconnect cuts short, and connects again after': async function() {
    const server = await startServer(goodServer);
    const client = new ModbusClient({ host: '127.0.0.1', port: server.address().port, timeout: 500 });
    try {
      const connecting = client.connect(); // the socket is connecting now
      client.disconnect();
      await assert.rejects(connecting, (error) => ModbusClient.isConnectError(error));
      assert.strictEqual((await client.readRegisters(7, 1)).readUInt16BE(0), 7);
    } finally {
      client.destroy();
      server.close();
    }
  },

  'serves other unit ids over the same socket': async function() {
    const units = [];
    let connections = 0;
    const server = await startServer((frame, socket) => {
      units.push(frame.readUInt8(6));
      goodServer(frame, socket);
    });
    server.on('connection', () => {
      connections += 1;
    });
    const client = new ModbusClient({ host: '127.0.0.1', port: server.address().port, timeout: 500 });
    try {
      const follower = client.forUnit(2);
      await Promise.all([client.readRegisters(1, 1), follower.readRegisters(1, 1), follower.writeRegister(2, 5)]);
      assert.deepStrictEqual(units, [1, 2, 2]);
      assert.strictEqual(connections, 1);
      assert.strictEqual(follower.id, `127.0.0.1:${server.address().port}#2`);
    } finally {
      client.destroy();
      server.close();
    }
  },

  'keeps gapMs between two requests': async function() {
    const arrivals = [];
    const server = await startServer((frame, socket) => {
      arrivals.push(Date.now());
      goodServer(frame, socket);
    });
    const client = new ModbusClient({
      host: '127.0.0.1', port: server.address().port, timeout: 500, gapMs: 100,
    });
    try {
      await Promise.all([client.readRegisters(1, 1), client.writeRegister(2, 5)]);
      assert.ok(arrivals[1] - arrivals[0] >= 95, `requests ${arrivals[1] - arrivals[0]} ms apart`);
    } finally {
      client.destroy();
      server.close();
    }
  },
};

const main = async () => {
  let failed = 0;
  for (const [name, test] of Object.entries(tests)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await test();
      console.log(`  ok   ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL ${name}: ${error.stack}`);
    }
  }
  if (failed) {
    console.error(`FAIL - ${failed} ModbusClient test(s)`);
    process.exit(1);
  }
  console.log(`OK - ${Object.keys(tests).length} ModbusClient tests`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
