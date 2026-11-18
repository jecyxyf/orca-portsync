const { plugin, shell } = window.orca;
const workspaceList = document.getElementById('workspace');
const settings = document.getElementById('settings');
const pathLabel = document.getElementById('path');
const connection = document.getElementById('connection');
const aliasLabel = document.getElementById('alias-label');
const aliasInput = document.getElementById('alias');
const enabledInput = document.getElementById('enabled');
const saveButton = document.getElementById('save');
const message = document.getElementById('message');
const forwarding = document.getElementById('forwarding');
const ports = document.getElementById('ports');
const manual = document.getElementById('manual');
const manualForm = document.getElementById('manual-form');
const remotePort = document.getElementById('remote-port');
const localPort = document.getElementById('local-port');
const addButton = document.getElementById('add');

let state = { workspaces: [], error: '' };
let optionsKey;
let selectedId;
let changed = false;
let saving = false;
let actionError = '';

function label(text, className = '') {
  const span = document.createElement('span');
  span.textContent = text;
  span.className = className;
  return span;
}

function localAddress(port) {
  const link = document.createElement('a');
  link.href = `http://127.0.0.1:${port}/`;
  link.textContent = `127.0.0.1:${port}`;
  link.addEventListener('click', event => {
    event.preventDefault();
    void shell.openExternal(link.href).catch(error => {
      actionError = error.message;
      render();
    });
  });
  return link;
}

function portRow({ host, port, process, local, source, remove, error }) {
  const row = document.createElement('li');
  const remote = document.createElement('div');
  const origin = document.createElement('div');
  const address = host.includes(':') ? `[${host}]` : host;
  remote.append(label(`${address}:${port}`, 'muted'));
  if (process) remote.append(label(process, 'process muted'));
  origin.className = 'origin';
  origin.append(label(source));
  if (remove) origin.append(remove);
  row.append(remote, local, origin);
  if (error) row.append(label(error, 'row-error muted'));
  return row;
}

function render() {
  const options = [...state.workspaces].sort((a, b) => Number(b.enabled) - Number(a.enabled))
    .map(({ id, name }) => [id, name]);
  const key = JSON.stringify(options);
  if (optionsKey !== key) {
    const previousId = workspaceList.value;
    workspaceList.replaceChildren(...options.map(([id, name]) => new Option(name, id)));
    if (!options.length) workspaceList.add(new Option('当前没有已连接的远程工作区', ''));
    if (options.some(([id]) => id === previousId)) workspaceList.value = previousId;
    optionsKey = key;
  }
  workspaceList.disabled = saving || !options.length;
  const workspace = state.workspaces.find(item => item.id === workspaceList.value);
  settings.hidden = pathLabel.hidden = manual.hidden = !workspace;
  pathLabel.textContent = workspace?.path ?? '';
  aliasLabel.textContent = workspace?.paired ? 'OpenSSH 主机别名（可选）' : 'OpenSSH 主机别名';
  if (selectedId !== workspace?.id) {
    connection.open = !workspace?.paired;
    manualForm.reset();
  }
  if (selectedId !== workspace?.id || !changed) {
    aliasInput.value = workspace?.alias ?? '';
    enabledInput.checked = workspace?.enabled ?? false;
    selectedId = workspace?.id;
    changed = false;
  }
  saveButton.disabled = saving || !changed;
  aliasInput.disabled = enabledInput.disabled = saving;
  remotePort.disabled = localPort.disabled = addButton.disabled = saving;
  const mappings = workspace?.ports ?? [];
  const discovered = workspace?.discovered ?? [];
  message.textContent = actionError || state.error || workspace?.error || (workspace?.enabled && !discovered.length
    ? '等待项目服务启动…'
    : '');
  const manualRules = workspace?.manual ?? [];
  const manualPorts = new Set(manualRules.map(rule => rule.remotePort));
  const automaticRows = discovered.filter(port => !manualPorts.has(port.port)).map(port => {
    const mapping = mappings.find(item => item.remoteHost === port.host && item.remotePort === port.port);
    return portRow({
      ...port, source: '自动',
      local: mapping ? localAddress(mapping.localPort) : label('等待转发', 'muted')
    });
  });
  const manualRows = manualRules.map(rule => {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.textContent = '删除';
    remove.disabled = saving;
    remove.setAttribute('aria-label', `删除本机端口 ${rule.localPort} 的转发`);
    remove.addEventListener('click', () => void perform('portsync.removeManual', { localPort: rule.localPort }));
    const process = discovered.find(port => port.host === '127.0.0.1' && port.port === rule.remotePort)?.process;
    return portRow({
      host: '127.0.0.1', port: rule.remotePort, process, source: '手动', remove,
      local: rule.active ? localAddress(rule.localPort) : label(`127.0.0.1:${rule.localPort}`, 'muted'),
      error: rule.active ? '' : rule.error || '等待转发'
    });
  });
  forwarding.hidden = !automaticRows.length && !manualRows.length;
  ports.replaceChildren(...manualRows, ...automaticRows);
}

async function perform(action, input, onSuccess) {
  const id = workspaceList.value;
  saving = true;
  actionError = '';
  render();
  try {
    state = await plugin.request(action, { id, ...input });
    onSuccess?.();
  } catch (error) {
    actionError = error.message;
  } finally {
    saving = false;
    render();
  }
}

workspaceList.addEventListener('change', () => {
  actionError = '';
  render();
});
settings.addEventListener('input', () => {
  changed = true;
  saveButton.disabled = saving;
});
settings.addEventListener('submit', event => {
  event.preventDefault();
  void perform('portsync.save', { alias: aliasInput.value, enabled: enabledInput.checked },
    () => { changed = false; });
});
manualForm.addEventListener('submit', event => {
  event.preventDefault();
  void perform('portsync.addManual', { remotePort: remotePort.valueAsNumber, localPort: localPort.valueAsNumber },
    () => manualForm.reset());
});
plugin.on('portsync.changed', update => {
  state = update;
  render();
});
void plugin.request('portsync.state').then(update => {
  state = update;
  render();
}).catch(error => {
  message.textContent = error.message;
});
