import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const scanScript = readFile(new URL('./scan.sh', import.meta.url), 'utf8');
const LOCAL_HOST = '127.0.0.1';

export function validAlias(value) {
  return typeof value === 'string' && /^[\p{L}\p{N}_][\p{L}\p{N}._-]{0,252}$/u.test(value);
}

function quote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function describe(error) {
  return error.stderr?.trim() || error.message;
}

function parseListeners(stdout) {
  const listeners = new Map();
  for (const line of stdout.split('\n')) {
    const [family, endpoint, process] = line.split('\t', 3);
    if (family !== '4' && family !== '6') continue;
    const match = /^(.+):(\d+)$/.exec(endpoint ?? '');
    if (!match) continue;
    const [, address, rawPort] = match;
    let host = address.replace(/^\[(.*)\]$/, '$1');
    if (host === '*' || host === '0.0.0.0' || host === '::') {
      host = family === '4' ? LOCAL_HOST : '::1';
    }
    const port = Number(rawPort);
    if (!isIP(host) || port < 1 || port > 65535) continue;
    listeners.set(`${host}/${port}`, { host, port, process: process?.trim() ?? '' });
  }
  return [...listeners.values()].sort((a, b) => a.port - b.port || a.host.localeCompare(b.host));
}

async function freeLocalPort(preferredPort = 0) {
  const probe = createServer().listen(preferredPort, LOCAL_HOST);
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

function forwardSpec({ host, port }, localPort) {
  const remoteHost = isIP(host) === 6 ? `[${host}]` : host;
  return `${LOCAL_HOST}:${localPort}:${remoteHost}:${port}`;
}

function sshDestination(target) {
  if (validAlias(target)) return { alias: target, args: [] };
  if (!target || typeof target.host !== 'string' ||
    !(validAlias(target.host) || isIP(target.host)) || !validAlias(target.username) ||
    !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    throw new Error('请输入有效的 OpenSSH 主机别名。');
  }
  const alias = validAlias(target.alias) ? target.alias : target.host;
  const args = ['-o', `HostName=${target.host}`, '-l', target.username, '-p', String(target.port)];
  if (target.identity) args.push('-i', target.identity);
  if (target.jump) args.push('-J', target.jump);
  return { alias, args };
}

export async function connectSsh(destination, { configFile, signal } = {}) {
  const { alias, args } = sshDestination(destination);
  signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'portsync-'));
  const socket = join(directory, 'mux');
  const config = configFile ? ['-F', configFile] : [];

  // The remote cat keeps stdin tied to the worker. Closing the worker's pipe ends the session.
  const child = spawn('ssh', [
    ...config, '-M', '-S', socket, '-T',
    '-o', 'ControlPersist=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'PermitLocalCommand=no', '-o', 'RemoteCommand=none',
    '-o', 'SessionType=default', '-o', 'StdinNull=no', '-o', 'ForkAfterAuthentication=no',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'UpdateHostKeys=no', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
    '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
    ...args, '--', alias, 'cat >/dev/null'
  ], { stdio: ['pipe', 'ignore', 'pipe'], signal });

  let stderr = '';
  let closed = false;
  child.stdin.on('error', () => {});
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  child.on('error', error => { stderr = error.message; });
  const exit = new Promise(resolve => child.once('close', () => {
    closed = true;
    resolve();
  }));
  let closing;
  function close() {
    if (!closing) {
      child.stdin.destroy();
      child.kill();
      closing = exit.then(() => rm(directory, { recursive: true, force: true }));
    }
    return closing;
  }

  // Keep control commands isolated from the alias's unrelated forwarding rules.
  const controlArgs = ['-F', '/dev/null', '-S', socket, '-o', 'BatchMode=yes'];
  function control(action, args = []) {
    return exec('ssh', [...controlArgs, '-O', action, ...args, '--', alias], {
      timeout: 4000, signal
    });
  }

  try {
    const deadline = Date.now() + 9000;
    while (true) {
      signal?.throwIfAborted();
      if (closed || Date.now() >= deadline) {
        throw new Error(stderr.trim() || `SSH 连接失败：${alias}`);
      }
      try {
        await control('check');
        break;
      } catch {
        await delay(100, undefined, { signal });
      }
    }
    return {
      get closed() { return closed; },
      close,
      async scan(path, nestedPaths = []) {
        const args = [path, ...nestedPaths].map(quote).join(' ');
        const cmd = `sh -c ${quote(await scanScript)} sh ${args}`;
        try {
          const { stdout } = await exec('ssh', [
            ...controlArgs, '-T', '-o', 'ProxyCommand=false', '--', alias, cmd
          ], { timeout: 8000, signal });
          return parseListeners(stdout);
        } catch (error) {
          throw new Error(describe(error));
        }
      },
      async forward(listener, preferredPort) {
        if (preferredPort !== undefined) {
          try {
            await freeLocalPort(preferredPort);
          } catch (error) {
            if (error.code === 'EADDRINUSE') throw new Error(`本机端口 ${preferredPort} 已被占用。`);
            throw error;
          }
        }
        const attempts = preferredPort === undefined ? 4 : 1;
        for (let attempt = 0; attempt < attempts; attempt++) {
          const localPort = preferredPort ?? (attempt === 0 ? listener.port : await freeLocalPort());
          const spec = forwardSpec(listener, localPort);
          try {
            await control('forward', ['-o', 'ExitOnForwardFailure=yes', '-L', spec]);
            return { localPort, spec };
          } catch (error) {
            if (closed || signal?.aborted || attempt === attempts - 1) {
              if (!closed && preferredPort !== undefined &&
                /address already in use/i.test(stderr)) {
                throw new Error(`本机端口 ${preferredPort} 已被占用。`);
              }
              throw new Error(describe(error));
            }
          }
        }
      },
      async cancel({ spec }) {
        if (!closed) await control('cancel', ['-L', spec]);
      }
    };
  } catch (error) {
    await close();
    throw error;
  }
}
