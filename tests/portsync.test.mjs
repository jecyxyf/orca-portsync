import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { connectSsh, validAlias } from '../src/ssh.mjs';
import { runPortSync } from '../src/worker.mjs';

const exec = promisify(execFile);
const host = '127.0.0.1';
const sshd = '/usr/sbin/sshd';

test('SSH aliases cannot supply options or shell commands', () => {
  assert.equal(validAlias('devbox-1.local'), true);
  assert.equal(validAlias('开发机-1'), true);
  for (const value of ['-F', 'dev box', 'user@host', '', 'host;echo test', null]) {
    assert.equal(validAlias(value), false);
  }
});

async function until(predicate, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(40);
  }
  assert.fail(message);
}

async function listen(port = 0) {
  const server = createServer().listen(port, host);
  await once(server, 'listening');
  return server;
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

async function canConnect(port) {
  const socket = createConnection({ host, port });
  try {
    await once(socket, 'connect');
    return true;
  } catch {
    return false;
  } finally {
    socket.destroy();
  }
}

function track(child, cleanup) {
  const done = new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  cleanup.push(async () => {
    child.kill();
    await done;
  });
  return done;
}

async function startHttp(cwd, cleanup, portToUse = 0, bindHost = '127.0.0.2') {
  const child = spawn(process.execPath, ['-e', `
    const server = require('node:http').createServer((_, res) => res.end('fixture'));
    server.listen(${portToUse}, ${JSON.stringify(bindHost)}, () => console.log(server.address().port));
  `], { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  const done = track(child, cleanup);
  const port = await Promise.race([
    once(child.stdout, 'data').then(([bytes]) => Number(bytes)),
    done.then(() => { throw new Error('HTTP fixture exited'); })
  ]);
  assert.ok(port > 0);
  return { port, stop: async () => { child.kill(); await done; } };
}

async function sshFixture(directory, cleanup) {
  const hostKey = join(directory, 'host');
  const identity = join(directory, 'identity');
  await Promise.all([hostKey, identity].map(key => exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])));
  const reservation = await listen();
  const { port } = reservation.address();
  await closeServer(reservation);

  const knownHosts = join(directory, 'known_hosts');
  await writeFile(knownHosts, `[${host}]:${port} ${await readFile(hostKey + '.pub', 'utf8')}`);
  const sshdConfig = join(directory, 'sshd_config');
  await writeFile(sshdConfig, [
    `ListenAddress ${host}`, `Port ${port}`, `HostKey ${hostKey}`,
    `PidFile ${join(directory, 'pid')}`, `AuthorizedKeysFile ${identity}.pub`,
    'StrictModes no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'UsePAM no', 'AllowTcpForwarding yes'
  ].join('\n') + '\n');
  const configFile = join(directory, 'ssh_config');
  await writeFile(configFile, [
    'Host fixture', `  HostName ${host}`, `  User ${userInfo().username}`, `  Port ${port}`,
    `  IdentityFile ${identity}`, '  IdentitiesOnly yes', `  UserKnownHostsFile ${knownHosts}`
  ].join('\n') + '\n');

  const server = spawn(sshd, ['-D', '-e', '-f', sshdConfig], { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = '';
  server.stderr.on('data', b => { diagnostics += b.toString(); });
  track(server, cleanup);
  await until(async () => {
    assert.equal(server.exitCode, null, diagnostics);
    return canConnect(port);
  }, 'sshd did not start');
  return configFile;
}

function mockOrca(workspaces) {
  const handlers = new Map();
  let saved;
  let snapshot;
  return {
    get snapshot() { return snapshot; },
    call(name, input) { return handlers.get(name)(input); },
    orca: {
      host: {
        async call(method) {
          if (method === 'workspace.list') return { workspaces };
          assert.equal(method, 'statusBar.update');
        },
      },
      storage: {
        async get() { return saved; },
        async set(_, value) { saved = value; }
      },
      panels: {
        handle(name, handler) {
          handlers.set(name, handler);
          return { dispose: () => handlers.delete(name) };
        },
        post(_, state) { snapshot = state; }
      },
      log(text) { assert.fail(text); }
    }
  };
}

test('real SSH forwards only the enabled project, resolves a collision and cleans up', { timeout: 35_000 }, async t => {
  try {
    await Promise.all([access(sshd), exec('ss', ['-V'])]);
  } catch {
    t.skip('需要 Linux、ss 和 /usr/sbin/sshd');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'portsync-test-'));
  const cleanup = [];
  t.after(async () => {
    try {
      for (const dispose of cleanup.reverse()) await dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const project = join(directory, "project's app");
  const foreign = project + '-separate';
  const nested = join(project, 'nested');
  await Promise.all([project, foreign, nested].map(path => mkdir(path, { recursive: true })));
  const other = await startHttp(foreign, cleanup);
  const nestedService = await startHttp(nested, cleanup);
  const configFile = await sshFixture(directory, cleanup);

  const workspaces = [project, nested].map((path, index) => ({
    hostId: 'ssh:fixture', id: String(index), path, name: 'Project ' + index
  }));
  const mock = mockOrca(workspaces);
  const runtime = runPortSync(mock.orca, {
    paired: { async list() { return []; } },
    connect: (alias, options) => connectSsh(alias, { ...options, configFile }), pollMs: 90
  });
  cleanup.push(() => runtime.dispose());
  await mock.call('portsync.state');
  await mock.call('portsync.save', { id: '0', alias: 'fixture', enabled: true });
  const collision = await listen();
  cleanup.push(() => closeServer(collision));
  const service = await startHttp(project, cleanup, collision.address().port);

  const selected = () => mock.snapshot?.workspaces.find(item => item.id === '0');
  const mapping = await until(() => selected()?.ports.find(entry => entry.remotePort === service.port),
    'No forwarding appeared for the project service');
  assert.notEqual(mapping.localPort, service.port);
  assert.ok(selected().ports.every(entry => ![other.port, nestedService.port].includes(entry.remotePort)));
  assert.equal(await (await fetch(`http://${host}:${mapping.localPort}/`)).text(), 'fixture');

  await service.stop();
  await until(() => selected()?.ports.length === 0, 'Stopped service retained an SSH forward');
  assert.equal(await canConnect(mapping.localPort), false);

  const replacement = await startHttp(project, cleanup);
  const second = await until(() => selected()?.ports.find(entry => entry.remotePort === replacement.port),
    'No forwarding appeared for the replacement service');
  assert.equal(second.localPort, replacement.port);
  await mock.call('portsync.save', { id: '0', alias: 'fixture', enabled: false });
  assert.equal(selected().enabled, false);
  assert.equal(await canConnect(second.localPort), false);
});

test('a paired worktree discovers ports and a manual rule keeps its exact local port', { timeout: 35_000 }, async t => {
  try {
    await access(sshd);
  } catch {
    t.skip('需要 /usr/sbin/sshd');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'portsync-paired-'));
  const cleanup = [];
  t.after(async () => {
    try {
      for (const dispose of cleanup.reverse()) await dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const service = await startHttp(directory, cleanup, 0, host);
  const configFile = await sshFixture(directory, cleanup);
  const workspace = { id: 'pair', hostId: 'runtime:test', environment: 'test', path: directory, name: 'Paired' };
  const mock = mockOrca([]);
  const runtime = runPortSync(mock.orca, {
    paired: {
      async list() { return [workspace]; },
      async scan() { return [{ host, port: service.port }]; }
    },
    readSshTarget: async () => 'fixture',
    connect: (alias, options) => connectSsh(alias, { ...options, configFile }),
    pollMs: 90
  });
  cleanup.push(() => runtime.dispose());
  assert.equal((await mock.call('portsync.state')).workspaces[0].paired, true);
  const reservation = await listen();
  let reservationOpen = true;
  cleanup.push(() => reservationOpen && closeServer(reservation));
  const { port: localPort } = reservation.address();
  const selected = () => mock.snapshot?.workspaces[0];

  await mock.call('portsync.addManual', { id: 'pair', remotePort: service.port, localPort });
  assert.equal(selected().enabled, false);
  assert.equal(selected().manual[0].localPort, localPort);
  assert.equal(selected().manual[0].active, false);
  assert.match(selected().manual[0].error, /已被占用/);

  await closeServer(reservation);
  reservationOpen = false;
  await until(() => selected().manual[0].active, 'Manual rule did not retry its requested local port');
  assert.equal(await (await fetch(`http://${host}:${localPort}/`)).text(), 'fixture');

  await mock.call('portsync.save', { id: 'pair', alias: '', enabled: true });
  assert.deepEqual(selected().discovered, [{ host, port: service.port }]);
  assert.equal(selected().ports.length, 0);
  assert.equal(selected().manual[0].active, true);

  await mock.call('portsync.removeManual', { id: 'pair', localPort });
  assert.equal(selected().manual.length, 0);
  assert.equal(selected().ports[0].remotePort, service.port);
  assert.equal(await (await fetch(`http://${host}:${selected().ports[0].localPort}/`)).text(), 'fixture');
});
