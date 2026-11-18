import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function createOrcaCli() {
  const env = { ...process.env };
  delete env.ORCA_ENVIRONMENT;
  delete env.ORCA_PAIRING_CODE;
  const config = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const candidates = [
    join(dirname(process.execPath), 'resources', 'bin', 'orca'),
    'orca-ide',
    join(config, 'orca', 'linux-orca-cli-shim', 'orca'),
    'orca'
  ];
  let executable;

  return async function call(args, signal) {
    for (const file of executable ? [executable] : candidates) {
      let output;
      try {
        const { stdout } = await exec(file, [...args, '--json'], {
          env, signal, timeout: 7000, maxBuffer: 4 * 1024 * 1024
        });
        output = stdout;
      } catch (error) {
        if (error.code === 'ENOENT') {
          executable = undefined;
          continue;
        }
        if (!error.stdout) throw error;
        output = error.stdout;
      }
      const response = JSON.parse(output);
      if (!response.ok) throw new Error(response.error?.message ?? 'Orca 命令失败。');
      executable = file;
      return response.result;
    }
    throw new Error('找不到 Orca 命令行。');
  };
}

export function createPairedWorkspaces(call = createOrcaCli()) {
  let environments;
  let refreshedAt = -Infinity;

  async function list(signal) {
    if (Date.now() - refreshedAt > 15_000) {
      const [saved, connected] = await Promise.all([
        call(['environment', 'list'], signal),
        call(['host', 'list'], signal)
      ]);
      const connectedIds = new Set(connected.hosts.filter(host => host.kind === 'ssh' && host.connected)
        .map(host => host.id));
      environments = saved.environments.filter(environment =>
        connectedIds.has(environment.orcadDeployment?.sshTargetId));
      refreshedAt = Date.now();
    }

    const groups = await Promise.all(environments.map(async environment => {
      const { worktrees } = await call([
        'worktree', 'list', '--environment', environment.id, '--limit', '200'
      ], signal);
      return worktrees.filter(worktree => worktree.hostId === 'local' && !worktree.isArchived).map(worktree => ({
        id: `runtime:${environment.id}/${worktree.id}`,
        hostId: `runtime:${environment.id}`,
        environment: environment.id,
        hostName: environment.name,
        sshTarget: environment.orcadDeployment.sshTargetId,
        sshGeneration: environment.orcadDeployment.sshTargetGeneration,
        worktreeId: worktree.id,
        name: `${worktree.path.split('/').slice(-2).join('/')} · ${environment.name}`,
        path: worktree.path
      }));
    }));
    return groups.flat();
  }

  async function scan(workspace, signal) {
    const result = await call([
      'ports', '--environment', workspace.environment, '--worktree', `id:${workspace.worktreeId}`
    ], signal);
    if (result.unavailableReason) throw new Error(result.unavailableReason);
    return result.ports
      .filter(item => item.kind === 'workspace' && isIP(item.connectHost)
        && Number.isInteger(item.port) && item.port >= 1 && item.port <= 65535)
      .map(item => ({ host: item.connectHost, port: item.port, process: item.processName ?? '' }));
  }

  return { list, scan };
}

export function hasWorkspacePath(workspace) {
  return typeof workspace.path === 'string' && posix.isAbsolute(workspace.path)
    && posix.normalize(workspace.path) !== '/' && !/[\x00-\x1f\x7f]/.test(workspace.path);
}

export async function readOrcaSshTarget(workspace) {
  if (process.platform !== 'linux') {
    throw new Error('请填写此主机可用的 OpenSSH 别名。');
  }
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const root = join(config, 'orca');
  const { activeProfileId } = JSON.parse(await readFile(join(root, 'orca-profile-index.json'), 'utf8'));
  if (typeof activeProfileId !== 'string' || !/^[\w-]+$/.test(activeProfileId)) {
    throw new Error('无法识别 Orca 使用的配置。');
  }
  const { DatabaseSync } = await import('node:sqlite');
  // Only read connection coordinates. OpenSSH handles all authentication.
  const db = new DatabaseSync(join(root, 'profiles', activeProfileId, 'profile-state.db'), {
    readOnly: true, enableExtensionLoading: false
  });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=100;');
    const target = db.prepare(`
      SELECT json_extract(value, '$.host') AS host,
             json_extract(value, '$.username') AS username,
             json_extract(value, '$.port') AS port,
             json_extract(value, '$.configHost') AS alias,
             json_extract(value, '$.identityFile') AS identity,
             json_extract(value, '$.proxyJump') AS jump,
             json_extract(value, '$.proxyCommand') IS NOT NULL AS hasProxyCommand,
             json_extract(value, '$.generation') AS generation
      FROM profile_state_documents, json_each(payload)
      WHERE domain = 'sshTargets' AND json_extract(value, '$.id') = ?
    `).get(workspace.sshTarget);
    if (!target || (workspace.sshGeneration != null && target.generation !== workspace.sshGeneration)) {
      throw new Error('Orca 的 SSH 目标已变化，请重新连接该环境。');
    }
    if (target.hasProxyCommand && (!target.alias || target.alias === target.host)) {
      throw new Error('该主机使用自定义代理，请填写对应的 OpenSSH 别名。');
    }
    return target;
  } finally {
    db.close();
  }
}
