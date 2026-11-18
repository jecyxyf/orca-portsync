import { createPairedWorkspaces, hasWorkspacePath, readOrcaSshTarget } from './orca.mjs';
import { connectSsh, validAlias } from './ssh.mjs';

const STORE_KEY = 'workspaces';
const POLL_MS = 4000;

function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function hasRules(saved) {
  return saved?.enabled || Boolean(saved?.manual.length);
}

export function runPortSync(orca, {
  connect = connectSsh, paired = createPairedWorkspaces(),
  readSshTarget = readOrcaSshTarget, pollMs = POLL_MS
} = {}) {
  const stop = new AbortController();
  const sessions = new Map();
  const errors = new Map();
  const discoveries = new Map();
  const retryAuthAfter = new Map();
  let settings = new Map();
  let workspaces = [];
  let loaded = false;
  let listingError = '';
  let queue = Promise.resolve();
  let timer;
  let badge = '';
  let published = '';

  function scheduleTask(task) {
    const result = queue.then(() => {
      stop.signal.throwIfAborted();
      return task();
    });
    queue = result.catch(() => {});
    return result;
  }

  function configuration(workspace) {
    const saved = settings.get(workspace.id);
    return saved?.hostId === workspace.hostId && saved.path === workspace.path ? saved : undefined;
  }

  function snapshot() {
    return {
      error: listingError,
      workspaces: workspaces.map(workspace => {
        const saved = configuration(workspace);
        const session = sessions.get(workspace.id);
        return {
          id: workspace.id,
          name: workspace.name,
          path: workspace.path,
          paired: Boolean(workspace.environment),
          alias: saved?.alias ?? '',
          enabled: saved?.enabled === true,
          error: errors.get(workspace.id) ?? '',
          discovered: discoveries.get(workspace.id) ?? [],
          manual: (saved?.manual ?? []).map(rule => ({
            ...rule,
            active: session?.mappings.has(`manual:${rule.localPort}`) ?? false,
            error: session?.manualErrors.get(rule.localPort) ?? ''
          })),
          ports: [...(session?.mappings.values() ?? [])].filter(mapping => !mapping.manual)
            .map(({ localPort, listener }) => ({
            remoteHost: listener.host,
            remotePort: listener.port,
            localPort
          }))
        };
      })
    };
  }

  async function publish() {
    if (stop.signal.aborted) return;
    const state = snapshot();
    const serialized = JSON.stringify(state);
    if (serialized !== published) {
      orca.panels.post('portsync.changed', state);
      published = serialized;
    }
    const active = state.workspaces.reduce((count, workspace) =>
      count + workspace.ports.length + workspace.manual.filter(rule => rule.active).length, 0);
    const text = active ? `PortSync · ${active}` : 'PortSync';
    if (text === badge) return;
    try {
      await orca.host.call('statusBar.update', { id: 'ports', text });
      badge = text;
    } catch (error) {
      orca.log(error.message);
    }
  }

  async function closeSession(id) {
    const session = sessions.get(id);
    sessions.delete(id);
    await session?.ssh.close();
  }

  async function syncWorkspace(workspace, saved) {
    let session = sessions.get(workspace.id);
    let listeners = [];
    let scanError = '';

    async function scan(read) {
      try {
        listeners = await read();
      } catch (error) {
        scanError = error.message;
      }
      discoveries.set(workspace.id, listeners);
    }

    try {
      if (!hasRules(saved)) {
        await closeSession(workspace.id);
        errors.delete(workspace.id);
        discoveries.delete(workspace.id);
        retryAuthAfter.delete(workspace.id);
        return;
      }
      if (saved.enabled && workspace.environment) {
        await scan(() => paired.scan(workspace, stop.signal));
      }
      if (!saved.enabled) discoveries.delete(workspace.id);
      if (workspace.environment && !listeners.length && !saved.manual.length) {
        await closeSession(workspace.id);
        if (scanError) errors.set(workspace.id, scanError);
        else errors.delete(workspace.id);
        return;
      }
      if (session?.ssh.closed) {
        await closeSession(workspace.id);
        session = undefined;
      }
      if (!session) {
        if (Date.now() < (retryAuthAfter.get(workspace.id) ?? 0)) return;
        const destination = saved.alias || await readSshTarget(workspace);
        const ssh = await connect(destination, { signal: stop.signal });
        session = { ssh, mappings: new Map(), manualErrors: new Map() };
        sessions.set(workspace.id, session);
        retryAuthAfter.delete(workspace.id);
      }

      if (saved.enabled && !workspace.environment) {
        const otherPaths = workspaces
          .filter(other => other.id !== workspace.id && other.hostId === workspace.hostId)
          .map(other => other.path);
        await scan(() => session.ssh.scan(workspace.path, otherPaths));
      }
      const currentPorts = new Map(saved.manual.map(rule => [`manual:${rule.localPort}`, {
        listener: { host: '127.0.0.1', port: rule.remotePort }, preferredPort: rule.localPort
      }]));
      const manualPorts = new Set(saved.manual.map(rule => rule.remotePort));
      for (const listener of listeners) {
        if (!manualPorts.has(listener.port)) {
          currentPorts.set(`${listener.host}/${listener.port}`, { listener });
        }
      }
      for (const [key, mapping] of session.mappings) {
        if (currentPorts.get(key)?.listener.port !== mapping.listener.port) {
          await session.ssh.cancel(mapping);
          session.mappings.delete(key);
        }
      }
      if (scanError) errors.set(workspace.id, scanError);
      else errors.delete(workspace.id);
      session.manualErrors.clear();
      for (const [key, { listener, preferredPort }] of currentPorts) {
        if (session.mappings.has(key)) continue;
        stop.signal.throwIfAborted();
        try {
          const mapping = await session.ssh.forward(listener, preferredPort);
          session.mappings.set(key, { ...mapping, listener, manual: preferredPort !== undefined });
        } catch (error) {
          if (session.ssh.closed) throw error;
          if (preferredPort !== undefined) session.manualErrors.set(preferredPort, error.message);
          else errors.set(workspace.id, error.message);
        }
      }
    } catch (error) {
      await closeSession(workspace.id);
      if (!stop.signal.aborted) {
        const authError = /permission denied/i.test(error.message);
        if (authError && !session) retryAuthAfter.set(workspace.id, Date.now() + 20_000);
        errors.set(workspace.id, authError ? 'OpenSSH 登录失败。请使用能免交互登录此主机的别名。' : error.message);
      }
    }
  }

  async function readWorkspaces() {
    if (!loaded) {
      const stored = await orca.storage.get(STORE_KEY);
      if (Array.isArray(stored)) {
        settings = new Map(stored.filter(row => typeof row?.id === 'string')
          .map(row => [row.id, {
            ...row,
            alias: validAlias(row.alias) ? row.alias : '',
            manual: Array.isArray(row.manual)
              ? row.manual.filter(rule => validPort(rule?.remotePort) && validPort(rule.localPort))
              : []
          }]));
      }
      loaded = true;
    }
    const result = await orca.host.call('workspace.list', undefined, { signal: stop.signal });
    const direct = result.workspaces.filter(workspace => workspace.hostId?.startsWith('ssh:'));
    listingError = '';
    try {
      workspaces = [...direct, ...await paired.list(stop.signal)].filter(hasWorkspacePath);
    } catch {
      workspaces = direct.filter(hasWorkspacePath);
      listingError = '暂时无法读取 Orca 配对工作区。';
    }
  }

  async function poll() {
    await readWorkspaces();
    const active = workspaces.filter(workspace => hasRules(configuration(workspace)));
    const activeIds = new Set(active.map(workspace => workspace.id));
    await Promise.all([...sessions.keys()].filter(id => !activeIds.has(id)).map(closeSession));
    for (const id of errors.keys()) {
      if (!activeIds.has(id)) errors.delete(id);
    }
    for (const id of discoveries.keys()) {
      if (!activeIds.has(id)) discoveries.delete(id);
    }
    for (const id of retryAuthAfter.keys()) {
      if (!activeIds.has(id)) retryAuthAfter.delete(id);
    }
    await Promise.all(active.map(workspace => syncWorkspace(workspace, configuration(workspace))));
    await publish();
  }

  function tick() {
    clearTimeout(timer);
    void scheduleTask(async () => {
      try {
        await poll();
      } catch (error) {
        if (stop.signal.aborted) return;
        listingError = `刷新失败：${error.message}`;
        await Promise.all([...sessions.keys()].map(closeSession));
        await publish();
      }
    }).catch(error => {
      if (!stop.signal.aborted) orca.log(error.message);
    }).finally(() => {
      if (!stop.signal.aborted) timer = setTimeout(tick, pollMs);
    });
  }

  const ready = scheduleTask(readWorkspaces).catch(error => {
    listingError = `读取工作区失败：${error.message}`;
  });

  const view = orca.panels.handle('portsync.state', async () => {
    await ready;
    return snapshot();
  });
  async function saveConfiguration(workspace, previous, next) {
    const updated = new Map(settings);
    if (next.alias || hasRules(next)) {
      updated.set(workspace.id, {
        id: workspace.id, hostId: workspace.hostId, path: workspace.path, ...next
      });
    } else {
      updated.delete(workspace.id);
    }
    await orca.storage.set(STORE_KEY, [...updated.values()]);
    settings = updated;
    if (previous.alias !== next.alias) {
      retryAuthAfter.delete(workspace.id);
      await closeSession(workspace.id);
    }
    await syncWorkspace(workspace, next);
    await publish();
    return snapshot();
  }

  function change(name, update) {
    return orca.panels.handle(name, input => scheduleTask(async () => {
      const workspace = workspaces.find(item => item.id === input?.id);
      if (!workspace) throw new Error('该远程工作区已不可用。');
      const previous = configuration(workspace) ?? { alias: '', enabled: false, manual: [] };
      return saveConfiguration(workspace, previous, update(workspace, previous, input));
    }));
  }

  const save = change('portsync.save', (workspace, previous, input) => {
    const alias = typeof input.alias === 'string' ? input.alias.trim() : '';
    const enabled = input.enabled === true;
    if ((alias || (!workspace.environment && (enabled || previous.manual.length))) && !validAlias(alias)) {
      throw new Error('请输入 OpenSSH 主机别名，例如 devbox。');
    }
    return { ...previous, alias, enabled };
  });
  const add = change('portsync.addManual', (workspace, previous, { remotePort, localPort }) => {
    if (!validPort(remotePort) || !validPort(localPort)) throw new Error('端口必须是 1–65535 的整数。');
    if (!workspace.environment && !previous.alias) throw new Error('请先保存此工作区的 SSH 主机别名。');
    if (previous.manual.some(rule => rule.localPort === localPort)) {
      throw new Error(`本机端口 ${localPort} 已有手动转发。`);
    }
    return { ...previous, manual: [...previous.manual, { remotePort, localPort }] };
  });
  const remove = change('portsync.removeManual', (_workspace, previous, { localPort }) => ({
    ...previous,
    manual: previous.manual.filter(rule => rule.localPort !== localPort)
  }));
  tick();

  return {
    async dispose() {
      stop.abort();
      clearTimeout(timer);
      view.dispose();
      save.dispose();
      add.dispose();
      remove.dispose();
      await queue;
      await Promise.all([...sessions.keys()].map(closeSession));
    }
  };
}

let service;

export default function activate(orca) {
  service = runPortSync(orca);
}

export async function deactivate() {
  await service?.dispose();
  service = undefined;
}
