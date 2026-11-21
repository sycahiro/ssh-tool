// SSH Tool 前端主逻辑。
//
// 结构：
//   - 左侧栏：本机终端会话 + 服务器列表（点服务器 = 开 ssh 终端标签）
//   - 标签区：终端标签 / 文件传输视图 / 设置视图，三视图互切
//   - 文件传输：双栏（本机 ⇄ 服务器）+ 底部传输列表
//
// 后端命令：term_spawn / ssh_session / term_write / term_resize / term_close
//           servers_list / servers_save / browse_local / browse_remote / local_home
//           local_mkdir / remote_mkdir / transfer / transfer_cancel

import { iconForFile } from './fileicons.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const tauriAvailable = !!window.__TAURI__;

// ---------- 浏览器行为拦截 ----------
window.addEventListener('contextmenu', (e) => {
  const t = e.target;
  if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
  e.preventDefault();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) e.preventDefault();
}, true);

// ---------- 工具 ----------
const encoder = new TextEncoder();
const b64encode = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};
const b64decode = (str) => {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const $ = (id) => document.getElementById(id);
const noop = () => {};
const fmtSize = (n) => {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
};
const fmtDate = (raw) => {
  if (!raw) return '';
  const asNum = Number(raw);
  if (!Number.isNaN(asNum) && asNum > 1e8) {
    const d = new Date(asNum * 1000);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  return raw;
};

// ---------- 设置 ----------
// 字体直接使用 Windows 已安装的字体，不再内置字体文件。
function normalizeFont(raw) {
  const fam = String(raw || '').trim().replace(/^['"]|['"]$/g, '');
  if (!fam || /^jetbrains mono$/i.test(fam)) return 'Consolas';
  return fam;
}
function fontStack(raw) {
  const fam = normalizeFont(raw);
  const quoted = /[^A-Za-z0-9_-]/.test(fam) ? `"${fam}"` : fam;
  return `${quoted}, Consolas, monospace`;
}

// 所有配置（服务器 + 字体 + 字号 + 上次本机目录）都存在 exe 同级的
// ssh-tool.json 里，由后端读写；启动时 loadSettings() 拉一次。
const settings = {
  font: 'Consolas',
  fontSize: 14,
  localPath: '',
  view: 'term',
};

/// 把当前设置写回 ssh-tool.json（设置页实时保存，没有保存按钮）
function saveUiSettings() {
  if (!tauriAvailable) return;
  invoke('ui_settings_save', {
    settings: {
      font: settings.font,
      font_size: settings.fontSize,
      local_path: settings.localPath,
    },
  }).catch(noop);
}

async function loadSettings() {
  if (!tauriAvailable) return;
  try {
    const s = await invoke('ui_settings');
    if (s) {
      settings.font = normalizeFont(s.font);
      const size = parseInt(s.font_size, 10);
      if (size >= 11 && size <= 22) settings.fontSize = size;
      settings.localPath = s.local_path || '';
      // 首次运行（文件里还没有这些字段）把默认值落盘，之后直接读
      if (!s.font || !s.font_size) saveUiSettings();
    }
  } catch {}
}

// ---------- 状态 ----------
let sessions = []; // {id, title, term, el, fit, alive, kind: 'local'|'ssh', server}
let servers = [];
let activeKey = null; // 'term:<id>' 或视图名 'settings'

const tabsEl = $('tabs');
const hostsEl = $('terminals');
const localListEl = $('local-list');
const serverListEl = $('server-list');
const statusDot = $('status-dot');
const statusText = $('status-text');

// ---------- 终端会话 ----------
function termOptions() {
  return {
    fontFamily: fontStack(settings.font),
    fontSize: settings.fontSize,
    lineHeight: 1.3,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 8000,
    macOptionIsMeta: true,
    theme: {
      background: '#17181d',
      foreground: '#e6e6ea',
      cursor: '#5b8def',
      cursorAccent: '#17181d',
      selectionBackground: 'rgba(91,141,239,0.32)',
      black: '#3b3f46', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
      blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#dcdfe4',
      brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379',
      brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd',
      brightCyan: '#56b6c2', brightWhite: '#ffffff',
    },
  };
}

function attachAppKeys(term, session) {
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    const mod = ev.ctrlKey || ev.metaKey;
    if (!mod) return true;
    const k = ev.key.toLowerCase();
    if (k === 't') { ev.preventDefault(); newLocalSession(); return false; }
    if (k === 'w') { ev.preventDefault(); closeSession(session); return false; }
    if (k === 'e' && session.kind === 'ssh' && session.server) {
      ev.preventDefault();
      openTransferWindow(session.server);
      return false;
    }
    return true;
  });
}

/// shell: 'powershell' | 'cmd'
async function newLocalSession(shell = 'powershell') {
  const host = document.createElement('div');
  host.className = 'terminal-host';
  hostsEl.appendChild(host);

  const term = new Terminal(termOptions());
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();

  const title = shell === 'cmd' ? '命令提示符' : 'PowerShell';
  const session = { id: -1, title, term, el: host, fit, alive: true, kind: 'local', shell, server: null };
  sessions.push(session);
  attachAppKeys(term, session);

  term.onData((data) => {
    if (session.id >= 0) invoke('term_write', { id: session.id, data: b64encode(encoder.encode(data)) }).catch(noop);
  });
  term.onResize(({ cols, rows }) => {
    if (session.id >= 0) invoke('term_resize', { id: session.id, cols, rows }).catch(noop);
  });

  activate(session);

  if (tauriAvailable) {
    try {
      const [program, args] = shell === 'cmd'
        ? ['cmd.exe', []]
        : await invoke('default_shell');
      const id = await invoke('term_spawn', { program, args, cols: term.cols, rows: term.rows });
      if (session.id === -1) session.id = id;
      // id 是后端分配的：回填后让当前选中键跟着切换，否则标签永远不高亮
      if (activeKey === 'term:-1') activeKey = 'term:' + id;
      renderAll();
    } catch (e) {
      term.writeln('\x1b[31m启动失败: ' + e + '\x1b[0m');
      session.alive = false;
    }
  } else {
    term.writeln('浏览器预览模式：请用 cargo run 启动桌面版。');
    session.id = Math.random();
  }
  renderAll();
}

/// 点侧边栏服务器：开一个 ssh 终端标签（密码自动应答）。
async function openSshSession(server) {
  // 每次点击都开一个新终端：同一台服务器允许同时开多个会话
  const host = document.createElement('div');
  host.className = 'terminal-host';
  hostsEl.appendChild(host);

  const term = new Terminal(termOptions());
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();

  const title = server.name || server.host;
  const session = { id: -1, title, term, el: host, fit, alive: true, kind: 'ssh', server };
  sessions.push(session);
  attachAppKeys(term, session);

  term.onData((data) => {
    if (session.id >= 0) invoke('term_write', { id: session.id, data: b64encode(encoder.encode(data)) }).catch(noop);
  });
  term.onResize(({ cols, rows }) => {
    if (session.id >= 0) invoke('term_resize', { id: session.id, cols, rows }).catch(noop);
  });

  activate(session);
  term.writeln(`\x1b[90m正在连接 ${server.user}@${server.host}:${server.port} ...\x1b[0m`);

  if (tauriAvailable) {
    try {
      const id = await invoke('ssh_session', {
        host: server.host,
        port: server.port || 22,
        user: server.user,
        password: server.password,
        cols: term.cols,
        rows: term.rows,
      });
      if (session.id === -1) session.id = id;
      if (activeKey === 'term:-1') activeKey = 'term:' + id;
      renderAll();
    } catch (e) {
      term.writeln('\x1b[31m连接失败: ' + e + '\x1b[0m');
      session.alive = false;
    }
  }
  renderAll();
}

function closeSession(session) {
  const i = sessions.indexOf(session);
  if (i < 0) return;
  session.term.dispose();
  session.el.remove();
  sessions.splice(i, 1);
  if (tauriAvailable && session.id >= 0) invoke('term_close', { id: session.id }).catch(noop);

  if (sessions.length === 0 && activeKey && activeKey.startsWith('term:')) {
    activeKey = null;
  } else if (activeKey === 'term:' + session.id) {
    const next = sessions[Math.min(i, sessions.length - 1)];
    activeKey = next ? 'term:' + next.id : null;
    if (next) activate(next);
  }
  renderAll();
}

function activate(session) {
  activeKey = 'term:' + session.id;
  for (const s of sessions) s.el.classList.toggle('visible', s === session);
  // 在设置页 / 欢迎页里点会话（或新建终端）时，切回终端视图
  settings.view = 'term';
  document.querySelector('.topbar').classList.remove('is-settings');
  settingsEl.classList.add('hidden');
  aboutEl.classList.add('hidden');
  terminalsEl.style.visibility = 'visible';
  requestAnimationFrame(() => {
    session.fit.fit();
    session.term.focus();
  });
  renderAll();
}

function resolveSession(id) {
  let s = sessions.find((x) => x.id === id);
  if (!s) {
    const pending = sessions.filter((x) => x.id === -1);
    if (pending.length === 1) {
      s = pending[0];
      s.id = id;
      if (activeKey === 'term:-1') activeKey = 'term:' + id;
    }
  }
  return s;
}

function markExited(id) {
  const s = resolveSession(id);
  if (!s || !s.alive) return;
  s.alive = false;
  s.title = s.kind === 'ssh' ? `${s.title}（已断开）` : '已退出';
  renderAll();
}

// ---------- 视图切换 ----------
// 文件传输已独立成子窗口（见 transfer.js），主窗口只剩 终端 / 设置 两个视图。
const terminalsEl = $('terminals');
const settingsEl = $('settings');
const aboutEl = $('about');
const welcomeEl = $('welcome');
const newMenuEl = $('new-menu');
const btnTabAdd = $('btn-tab-add');

function showView(v) {
  settings.view = v;
  // 设置页 / 关于页是独立页面：标签栏和「+」在那里没有意义，整条隐藏
  document.querySelector('.topbar').classList.toggle('is-settings', v !== 'term');
  settingsEl.classList.toggle('hidden', v !== 'settings');
  aboutEl.classList.toggle('hidden', v !== 'about');
  terminalsEl.style.visibility = v === 'term' ? 'visible' : 'hidden';

  if (v === 'term') {
    const s = sessions.find((x) => 'term:' + x.id === activeKey) || sessions[sessions.length - 1];
    if (s) { activeKey = 'term:' + s.id; requestAnimationFrame(() => { s.fit.fit(); s.term.focus(); }); }
  }
  renderAll();
}

/// 打开某台服务器的文件传输弹窗（与添加服务器同一套弹窗外壳）
function openTransferWindow(server) {
  if (!tauriAvailable) return;
  openTransfer(server);
}

// ---------- 渲染 ----------
function renderTabs() {
  tabsEl.innerHTML = '';
  for (const s of sessions) {
    const key = 'term:' + s.id;
    const tab = document.createElement('div');
    tab.className = 'tab' + (key === activeKey && settings.view === 'term' ? ' active' : '');
    tab.onclick = () => { showView('term'); activate(s); };

    const img = document.createElement('img');
    img.className = 'tab-icon';
    img.src = 'icons/terminal.svg';

    const name = document.createElement('span');
    name.textContent = s.title;
    if (!s.alive) name.style.color = 'var(--muted-foreground)';

    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '×';
    close.onclick = (e) => { e.stopPropagation(); closeSession(s); };

    tab.append(img, name, close);
    tabsEl.appendChild(tab);
  }
}

function renderSidebar() {
  localListEl.innerHTML = '';
  for (const s of sessions.filter((x) => x.kind === 'local')) {
    const item = document.createElement('div');
    item.className = 'side-item' + ('term:' + s.id === activeKey && settings.view === 'term' ? ' active' : '');
    item.onclick = () => { showView('term'); activate(s); };

    const dot = document.createElement('span');
    dot.className = 'dot' + (s.alive ? ' online' : '');
    const text = document.createElement('span');
    text.className = 'side-text';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.title;
    text.appendChild(name);

    item.append(dot, text);
    localListEl.appendChild(item);
  }

  serverListEl.innerHTML = '';
  for (const srv of servers) {
    const item = document.createElement('div');
    item.className = 'side-item';
    item.onclick = () => openSshSession(srv);

    const live = sessions.some(
      (x) => x.kind === 'ssh' && x.alive && x.server && x.server.id === srv.id
    );
    const dot = document.createElement('span');
    dot.className = 'dot' + (live ? ' online' : '');
    const text = document.createElement('span');
    text.className = 'side-text';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = srv.name || srv.host;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = live ? '已连接' : `${srv.user}@${srv.host}`;
    text.append(name, sub);
    item.title = live ? '已连接，点击切换' : '未连接，点击打开终端';

    // 文件传输：只给服务器行，本机没有；点哪台就开哪台自己的子窗口
    const transferBtn = document.createElement('button');
    transferBtn.className = 'side-act';
    transferBtn.title = `文件传输 · ${srv.name || srv.host}`;
    transferBtn.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M2.5 6.5 5.5 3.5 8.5 6.5"/><path d="M5.5 3.5v9"/>' +
      '<path d="M13.5 9.5 10.5 12.5 7.5 9.5"/><path d="M10.5 12.5v-9"/></svg>';
    transferBtn.onclick = (e) => {
      e.stopPropagation();
      openTransferWindow(srv);
    };

    item.append(dot, text, transferBtn);
    serverListEl.appendChild(item);
  }
  if (!servers.length) {
    const hint = document.createElement('div');
    hint.className = 'side-hint';
    hint.textContent = '还没有服务器，点左下角「设置」添加';
    serverListEl.appendChild(hint);
  }
}

function renderAll() {
  renderTabs();
  renderSidebar();
  updateStatus();
  updateWelcome();
}

function updateWelcome() {
  const show = sessions.length === 0 && settings.view === 'term';
  welcomeEl.classList.toggle('hidden', !show);
  if (show) terminalsEl.style.visibility = 'hidden';
}

function updateStatus() {
  if (settings.view === 'settings') {
    statusText.textContent = '设置';
    statusDot.classList.remove('online');
    return;
  }
  if (settings.view === 'about') {
    statusText.textContent = '关于';
    statusDot.classList.remove('online');
    return;
  }
  const cur = sessions.find((x) => 'term:' + x.id === activeKey);
  if (!cur) {
    statusDot.classList.remove('online');
    statusText.textContent = '就绪';
    return;
  }
  statusDot.classList.toggle('online', cur.alive);
  statusText.textContent = cur.alive
    ? `已连接 · ${cur.title}`
    : (cur.kind === 'ssh' ? '连接已断开' : '进程已退出');
}

// ---------- 文件传输弹窗 ----------
const transferModalEl = $('transfer-modal');
const localPane = { path: '', history: [], entries: [], sel: new Set(), error: null };
const remotePane = { path: '', history: [], entries: [], sel: new Set(), error: null };
let transferServer = null;
// 远端用户家目录（按服务器缓存）：Linux 普通用户通常看不到别人目录，默认就落在这里
const remoteHomes = new Map();
// 远端「常用位置」（含 Windows 驱动器探测）按服务器缓存：
// 探测要跑 ssh，放在打开弹窗时并行做一次，下拉框直接用缓存。
const remotePlaceCache = new Map();
const remotePlacePending = new Map();

const listLocalEl = $('list-local');
const listRemoteEl = $('list-remote');
const pathLocalEl = $('path-local');
const pathRemoteEl = $('path-remote');
const pathMenuEl = $('path-menu');

/// 拼接路径时沿用原路径的分隔符：Windows 路径用反斜杠，
/// 否则会拼出 D:\Program/Project 这种混着写的路径。
function joinPath(base, name) {
  if (/[\\/]$/.test(base)) return base + name;
  const win = base.includes('\\') || /^[A-Za-z]:$/.test(base);
  return base + (win ? '\\' : '/') + name;
}
function parentOf(path) {
  const p = path.replace(/[\\/]+$/, '');
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (i <= 0) return /^[A-Za-z]:/.test(p) ? p.slice(0, 2) + '\\' : '/';
  const head = p.slice(0, i);
  // "D:" 这种盘符本身不是可访问目录，父级应是盘根 "D:\"
  return /^[A-Za-z]:$/.test(head) ? head + '\\' : head;
}

/// 规范化 Windows 路径：`D:` 表示“D 盘当前目录”，不是盘根，
/// 必须写成 `D:\`；分隔符统一成反斜杠。
function normalizeLocalPath(p) {
  let s = String(p || '').trim();
  if (!s) return s;
  if (/^[A-Za-z]:$/.test(s)) return s.toUpperCase() + '\\';
  if (/^[A-Za-z]:/.test(s)) {
    const drive = s.slice(0, 2).toUpperCase();
    const rest = s.slice(2).replace(/\//g, '\\');
    return drive + (rest.startsWith('\\') ? rest : '\\' + rest);
  }
  return s;
}

async function openTransfer(server) {
  transferServer = server;
  transferModalEl.classList.remove('hidden');
  // 把焦点留在弹窗上，Esc / Tab 不会跑到底下的终端
  transferModalEl.querySelector('.modal-card').focus();
  $('transfer-title').textContent = `文件传输 · ${server.name || server.host}`;
  $('transfer-sub').textContent = `本机 ⇄ ${server.user}@${server.host}:${server.port || 22}`;
  $('badge-remote-name').textContent = server.name || server.host;
  $('badge-remote-sub').textContent = `${server.user}@${server.host}`;

  if (!localPane.path) localPane.path = normalizeLocalPath(settings.localPath || '');
  localPane.fallbackTried = false;
  const switched = remotePane.serverId !== server.id;
  remotePane.serverId = server.id;
  if (switched) {
    remotePane.history = [];
    remotePane.entries = [];
    remotePane.sel.clear();
  }
  // 每次打开都从该用户的家目录开始（普通用户通常看不到别人目录）
  remotePane.path = remoteHomes.get(server.id) || '';
  renderTransfers();
  // 两栏并行取数、一次画完：分两次渲染会像“闪两下”。
  // 两边的「位置」列表（含 Windows 驱动器探测）也在这里一起发出去，
  // 下拉框打开时直接用结果，不再现场探测。
  await Promise.all([loadLocalPlaces(), warmRemotePlaces(server.id), loadLocalPane(), loadRemotePane()]);
  if (transferModalEl.classList.contains('hidden')) return;
  renderTable(listLocalEl, localPane, true);
  updatePathLabel(localPane);
  renderTable(listRemoteEl, remotePane, false);
  updatePathLabel(remotePane);
  updateSendButtons();
}

function closeTransfer() {
  transferModalEl.classList.add('hidden');
  hidePathMenu();
}

$('transfer-close').onclick = closeTransfer;
transferModalEl.addEventListener('mousedown', (e) => {
  if (e.target.classList.contains('modal-backdrop')) closeTransfer();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!pathMenuEl.classList.contains('hidden')) { hidePathMenu(); return; }
  if (!transferModalEl.classList.contains('hidden')) closeTransfer();
});
document.addEventListener('mousedown', (e) => {
  if (pathMenuEl.classList.contains('hidden')) return;
  if (pathMenuEl.contains(e.target) || pathLocalEl.contains(e.target) || pathRemoteEl.contains(e.target)) return;
  hidePathMenu();
});

async function loadLocalPane() {
  if (!tauriAvailable) return;
  try {
    if (!localPane.path) localPane.path = await invoke('local_home');
    localPane.path = normalizeLocalPath(localPane.path);
    let res = await invoke('browse_local', { path: localPane.path });
    // 记住的路径已经不在了：退回家目录，而不是一直卡在错误上
    if (res.error && !localPane.fallbackTried) {
      localPane.fallbackTried = true;
      const home = await invoke('local_home');
      if (home && normalizeLocalPath(home) !== localPane.path) {
        localPane.path = normalizeLocalPath(home);
        res = await invoke('browse_local', { path: localPane.path });
      }
    }
    localPane.entries = res.entries || [];
    localPane.error = res.error;
    localPane.sel.clear();
    // 只有读成功的路径才记住：失败路径存下去会让下次打开也打不开
    if (!res.error) {
      settings.localPath = localPane.path;
      saveUiSettings();
    }
  } catch (e) {
    localPane.error = String(e);
    localPane.entries = [];
  }
}

async function loadRemotePane() {
  if (!transferServer || !tauriAvailable) return;
  try {
    const res = await invoke('browse_remote', {
      serverId: transferServer.id,
      path: remotePane.path,
    });
    if (res.path) remotePane.path = res.path;   // 空路径由后端解析成家目录
    if (res.home) remoteHomes.set(transferServer.id, res.home);
    remotePane.entries = res.entries || [];
    remotePane.error = res.error;
    remotePane.sel.clear();
  } catch (e) {
    remotePane.error = String(e);
    remotePane.entries = [];
  }
}

async function refreshLocalPane() {
  await loadLocalPane();
  renderTable(listLocalEl, localPane, true);
  updatePathLabel(localPane);
  updateSendButtons();
}

async function refreshRemotePane() {
  await loadRemotePane();
  renderTable(listRemoteEl, remotePane, false);
  updatePathLabel(remotePane);
  updateSendButtons();
}

function renderTable(container, pane, isLocal) {
  container.innerHTML = '';
  const headBox = container.closest('.file-table')?.querySelector('[data-check-all]');
  if (headBox) headBox.checked = pane.entries.length > 0 && pane.sel.size === pane.entries.length;
  if (pane.error) {
    const err = document.createElement('div');
    err.className = 'ftable-error';
    err.textContent = pane.error;
    container.appendChild(err);
    return;
  }
  if (!pane.entries.length) {
    const empty = document.createElement('div');
    empty.className = 'ftable-empty';
    empty.textContent = '空目录';
    container.appendChild(empty);
    return;
  }
  for (const [idx, e] of pane.entries.entries()) {
    const row = document.createElement('div');
    row.className = 'frow' + (pane.sel.has(idx) ? ' selected' : '');

    const check = document.createElement('span');
    check.className = 'col-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = pane.sel.has(idx);
    cb.onchange = () => {
      if (cb.checked) pane.sel.add(idx); else pane.sel.delete(idx);
      row.classList.toggle('selected', cb.checked);
      updateSendButtons();
    };
    check.appendChild(cb);

    const name = document.createElement('span');
    name.className = 'col-name';
    const icon = document.createElement('img');
    icon.className = 'ficon';
    icon.src = iconForFile(e.name, e.is_dir);
    const label = document.createElement('span');
    label.textContent = e.name;
    label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    name.append(icon, label);
    name.ondblclick = () => {
      if (!e.is_dir) return;
      const target = isLocal ? localPane : remotePane;
      target.history.push(target.path);
      target.fallbackTried = false;
      target.path = joinPath(target.path, e.name);
      isLocal ? refreshLocalPane() : refreshRemotePane();
    };

    const date = document.createElement('span');
    date.className = 'col-date';
    date.textContent = fmtDate(e.mtime);
    const size = document.createElement('span');
    size.className = 'col-size';
    size.textContent = e.is_dir ? '' : fmtSize(e.size);

    row.append(check, name, date, size);
    row.onclick = (ev) => {
      if (ev.target === cb) return;
      const on = !pane.sel.has(idx);
      if (on) pane.sel.add(idx); else pane.sel.delete(idx);
      cb.checked = on;
      row.classList.toggle('selected', on);
      updateSendButtons();
    };
    container.appendChild(row);
  }
}

function updateSendButtons() {
  $('btn-send-right').disabled = localPane.sel.size === 0;
  $('btn-send-left').disabled = remotePane.sel.size === 0;
}

function updatePathLabel(pane) {
  const el = pane === localPane ? $('path-local-text') : $('path-remote-text');
  if (el) el.textContent = pane.path || (pane === localPane ? '此电脑' : '/');
}

// ---------- 位置菜单 ----------
let localPlaces = [];

async function loadLocalPlaces() {
  if (localPlaces.length || !tauriAvailable) return localPlaces;
  try { localPlaces = await invoke('local_places'); } catch { localPlaces = []; }
  return localPlaces;
}

function popItem(label, icon, current, onClick) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'pop-item' + (current ? ' current' : '');
  const img = document.createElement('img');
  img.src = icon;
  img.alt = '';
  const span = document.createElement('span');
  span.className = 'pop-label';
  span.textContent = label;
  item.append(img, span);
  item.onclick = () => { hidePathMenu(); onClick(); };
  return item;
}
const popSep = () => {
  const d = document.createElement('div');
  d.className = 'pop-sep';
  return d;
};
const popGroup = (text) => {
  const d = document.createElement('div');
  d.className = 'pop-group';
  d.textContent = text;
  return d;
};

function decoratePlaces(list) {
  return (list || []).map((p) => ({
    label: p.label,
    path: p.path,
    icon:
      p.kind === 'home' ? 'icons/folder-home.svg'
        : p.kind === 'drive' ? 'icons/laptop.svg'
          : 'icons/folder-open.svg',
  }));
}

/// 预取远端「常用位置」：打开弹窗时发一次，结果按服务器缓存。
/// 同一个服务器同时只跑一次探测（pending 复用同一个 Promise）。
function warmRemotePlaces(serverId) {
  if (remotePlaceCache.has(serverId)) return Promise.resolve(remotePlaceCache.get(serverId));
  if (remotePlacePending.has(serverId)) return remotePlacePending.get(serverId);
  const task = invoke('remote_places', { serverId })
    .then((list) => {
      const places = decoratePlaces(list);
      remotePlaceCache.set(serverId, places);
      return places;
    })
    .catch(() => decoratePlaces([]))
    .finally(() => remotePlacePending.delete(serverId));
  remotePlacePending.set(serverId, task);
  return task;
}

/// 取远端常用位置：有缓存立刻返回（下拉框不再卡），没有才现探一次。
function remotePlaces(serverId) {
  if (!serverId) return Promise.resolve([]);
  if (remotePlaceCache.has(serverId)) return Promise.resolve(remotePlaceCache.get(serverId));
  return warmRemotePlaces(serverId);
}

async function openPathMenu(pane, anchor) {
  pathMenuEl.innerHTML = '';
  anchor.classList.add('open');
  const isLocal = pane === localPane;
  let added = 0;
  const sep = () => { if (added > 0) pathMenuEl.appendChild(popSep()); };

  const goTo = (p) => {
    pane.history.push(pane.path);
    pane.path = p;
    isLocal ? refreshLocalPane() : refreshRemotePane();
  };

  if (isLocal) {
    const places = await loadLocalPlaces();
    const drives = places.filter((p) => p.kind === 'drive');
    const folders = places.filter((p) => p.kind !== 'drive');
    if (drives.length) {
      pathMenuEl.appendChild(popGroup('驱动器'));
      for (const p of drives) {
        pathMenuEl.appendChild(popItem(p.label, 'icons/laptop.svg', p.path === pane.path, () => goTo(p.path)));
      }
      added++;
    }
    if (folders.length) {
      sep();
      pathMenuEl.appendChild(popGroup('常用位置'));
      for (const p of folders) {
        pathMenuEl.appendChild(popItem(p.label, 'icons/folder-home.svg', p.path === pane.path, () => goTo(p.path)));
      }
      added++;
    }
  } else {
    const places = await remotePlaces(pane.serverId || transferServer?.id);
    if (places.length) {
      pathMenuEl.appendChild(popGroup('常用位置'));
      for (const p of places) {
        pathMenuEl.appendChild(popItem(p.label, p.icon, samePath(p.path, pane.path), () => goTo(p.path)));
      }
      added++;
    }
  }

  const visited = [...new Set([...pane.history, pane.path])].filter(Boolean).reverse();
  if (visited.length) {
    sep();
    pathMenuEl.appendChild(popGroup('最近路径'));
    for (const p of visited) {
      pathMenuEl.appendChild(popItem(p, 'icons/folder-open.svg', p === pane.path, () => {
        if (p === pane.path) return;
        goTo(p);
      }));
    }
  }

  if (!pathMenuEl.children.length) {
    const empty = document.createElement('div');
    empty.className = 'pop-group';
    empty.textContent = '暂无路径';
    pathMenuEl.appendChild(empty);
  }
  showPopover(pathMenuEl, anchor, true);
}

const stripTail = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
const samePath = (a, b) => stripTail(a) === stripTail(b);

function hidePathMenu() {
  pathMenuEl.classList.add('hidden');
  pathLocalEl.classList.remove('open');
  pathRemoteEl.classList.remove('open');
}

/// 点同一个位置栏：开着就收起，关着就展开（之前只开不收，看着像关不掉）
function togglePathMenu(pane, anchor) {
  const openHere = !pathMenuEl.classList.contains('hidden') && anchor.classList.contains('open');
  if (openHere) { hidePathMenu(); return; }
  hidePathMenu();
  openPathMenu(pane, anchor);
}
pathLocalEl.onclick = (e) => { e.stopPropagation(); togglePathMenu(localPane, pathLocalEl); };
pathRemoteEl.onclick = (e) => { e.stopPropagation(); togglePathMenu(remotePane, pathRemoteEl); };

function navPane(pane, action, refresh) {
  if (action === 'back') {
    if (pane.history.length) { pane.path = pane.history.pop(); refresh(); }
  } else if (action === 'up') {
    const p = parentOf(pane.path);
    if (p !== pane.path) { pane.history.push(pane.path); pane.path = p; refresh(); }
  } else if (action === 'refresh') {
    refresh();
  } else if (action === 'mkdir') {
    const name = prompt('新建文件夹名称：');
    if (!name) return;
    const target = joinPath(pane.path, name);
    if (pane === remotePane && transferServer) {
      invoke('remote_mkdir', { serverId: transferServer.id, path: target }).then(refresh).catch(noop);
    } else if (pane === localPane) {
      invoke('local_mkdir', { path: target }).then(refresh).catch(noop);
    }
  }
}
document.querySelectorAll('#pane-local .tool-btn').forEach((b) => {
  b.onclick = () => navPane(localPane, b.dataset.nav, refreshLocalPane);
});
document.querySelectorAll('#pane-remote .tool-btn').forEach((b) => {
  b.onclick = () => navPane(remotePane, b.dataset.nav, refreshRemotePane);
});

document.querySelectorAll('.ftable-head [data-check-all]').forEach((box) => {
  box.onchange = () => {
    const isLocal = !!box.closest('#pane-local');
    const pane = isLocal ? localPane : remotePane;
    pane.sel.clear();
    if (box.checked) pane.entries.forEach((_, i) => pane.sel.add(i));
    renderTable(isLocal ? listLocalEl : listRemoteEl, pane, isLocal);
    updateSendButtons();
  };
});

// ---------- 传输任务 ----------
const transferListEl = $('transfer-list');
const transfers = new Map();
let pendingRows = [];
let transferSeq = 0;

function addTransfer(t) {
  const row = { ...t, percent: 0, status: '排队中', id: null, key: ++transferSeq };
  pendingRows.push(row);
  transfers.set(row.key, row);
  renderTransfers();
}
function bindTransferId(count, id) {
  const batch = pendingRows.splice(pendingRows.length - count, count);
  for (const r of batch) { r.id = id; r.status = '传输中'; }
  renderTransfers();
}
function markAllFailed(err) {
  for (const r of pendingRows.splice(0)) { r.status = '失败'; r.error = String(err); }
  renderTransfers();
}

$('btn-send-right').onclick = () => {
  if (!transferServer) return;
  const picked = [...localPane.sel].map((i) => localPane.entries[i]).filter(Boolean);
  if (!picked.length) return;
  const paths = picked.map((e) => joinPath(localPane.path, e.name));
  for (const p of paths) addTransfer({ name: p.split(/[\\/]/).pop(), dir: 'up', from: p, to: remotePane.path });
  invoke('transfer', { serverId: transferServer.id, direction: 'up', paths, dest: remotePane.path })
    .then((id) => { bindTransferId(paths.length, id); setTimeout(refreshRemotePane, 2000); })
    .catch(markAllFailed);
  localPane.sel.clear();
  renderTable(listLocalEl, localPane, true);
  updateSendButtons();
};

$('btn-send-left').onclick = () => {
  if (!transferServer) return;
  const picked = [...remotePane.sel].map((i) => remotePane.entries[i]).filter(Boolean);
  if (!picked.length) return;
  const paths = picked.map((e) => (remotePane.path === '/' ? '/' + e.name : joinPath(remotePane.path, e.name)));
  for (const p of paths) addTransfer({ name: p.split('/').pop(), dir: 'down', from: p, to: localPane.path });
  invoke('transfer', { serverId: transferServer.id, direction: 'down', paths, dest: localPane.path })
    .then((id) => bindTransferId(paths.length, id))
    .catch(markAllFailed);
  remotePane.sel.clear();
  renderTable(listRemoteEl, remotePane, false);
  updateSendButtons();
};

function renderTransfers() {
  transferListEl.innerHTML = '';
  if (!transfers.size) {
    transferListEl.innerHTML = '<div class="t-empty">暂无传输任务</div>';
    return;
  }
  for (const [key, t] of transfers) {
    const row = document.createElement('div');
    row.className = 'trow';

    const name = document.createElement('span');
    name.className = 't-name';
    name.textContent = (t.dir === 'up' ? '↑ ' : '↓ ') + t.name;

    const status = document.createElement('span');
    status.className = 't-status' + (t.status === '已完成' ? ' ok' : t.status === '失败' ? ' err' : '');
    status.textContent = t.status;

    const size = document.createElement('span');
    size.className = 't-size';
    size.textContent = t.percent ? t.percent.toFixed(0) + '%' : '';

    const from = document.createElement('span');
    from.className = 't-path';
    from.textContent = t.from;
    from.title = t.from;
    const to = document.createElement('span');
    to.className = 't-path';
    to.textContent = t.to;
    to.title = t.to;

    const cancel = document.createElement('button');
    cancel.className = 't-cancel';
    cancel.textContent = '✕';
    cancel.onclick = () => {
      if (t.id && t.status === '传输中') invoke('transfer_cancel', { id: t.id }).catch(noop);
      transfers.delete(key);
      renderTransfers();
    };

    row.append(name, status, size, from, to, cancel);
    if (t.status === '传输中' || (t.percent > 0 && t.status !== '失败')) {
      const bar = document.createElement('div');
      bar.className = 'tbar';
      const fill = document.createElement('i');
      fill.style.width = Math.min(100, t.percent) + '%';
      bar.appendChild(fill);
      row.appendChild(bar);
    }
    transferListEl.appendChild(row);
  }
}

$('btn-clear-done').onclick = () => {
  for (const [k, t] of [...transfers]) {
    if (t.status === '已完成' || t.status === '失败') transfers.delete(k);
  }
  renderTransfers();
};
$('btn-cancel-all').onclick = () => {
  for (const t of transfers.values()) {
    if (t.id && t.status === '传输中') invoke('transfer_cancel', { id: t.id }).catch(noop);
  }
};

if (tauriAvailable) {
  listen('transfer-progress', (event) => {
    const { id, percent, done, error } = event.payload;
    let changed = false;
    for (const t of transfers.values()) {
      if (t.id !== id) continue;
      changed = true;
      if (done) {
        t.status = error ? '失败' : '已完成';
        if (!error) {
          t.percent = 100;
          t.dir === 'up' ? setTimeout(refreshRemotePane, 1200) : setTimeout(refreshLocalPane, 1200);
        }
      } else {
        t.status = '传输中';
        t.percent = percent;
      }
    }
    if (changed) renderTransfers();
  });
}

// ---------- 设置视图 ----------
const serverRowsEl = $('server-rows');
const serverModalEl = $('server-modal');
let modalServer = null;
let modalSaving = false;
let fontsLoaded = false;

function osLabel(os) {
  return { linux: 'Linux', macos: 'macOS', windows: 'Windows' }[os] || 'Linux';
}

function openSettings() {
  renderServerRows();
  syncFontControls();
  showView('settings');
}

function openAbout() {
  showView('about');
}

// 关于页：版本号由后端从 Cargo.toml 读取，前端不再硬编码（避免两处版本漂移）
const ABOUT = {
  repo: 'https://github.com/sycahiro/ssh-tool',
};
if (tauriAvailable) {
  invoke('app_version')
    .then((v) => { if (v) $('about-version').textContent = v; })
    .catch(noop);
}
$('about-repo-text').textContent = ABOUT.repo.replace(/^https?:\/\//, '').replace(/\/$/, '');
// WebView 里的 <a target="_blank"> 不会开系统浏览器，必须走后端打开
$('about-repo').onclick = () => {
  if (tauriAvailable) invoke('open_external', { url: ABOUT.repo }).catch(noop);
  else window.open(ABOUT.repo, '_blank', 'noreferrer');
};

let installedFonts = [];

async function loadInstalledFonts() {
  if (fontsLoaded || !tauriAvailable) return installedFonts;
  fontsLoaded = true;
  try {
    installedFonts = (await invoke('installed_fonts')) || [];
  } catch {
    installedFonts = [];
    fontsLoaded = false;
  }
  return installedFonts;
}

function syncFontControls() {
  $('font-picker-name').textContent = settings.font;
  $('font-size').value = settings.fontSize;
  $('font-size-val').textContent = settings.fontSize;
  updateFontPreview();
  loadInstalledFonts();
}

function updateFontPreview() {
  $('font-preview').style.fontFamily = fontStack(settings.font);
  $('font-preview').style.fontSize = settings.fontSize + 'px';
}

// ---------- 字体弹层：搜索 + 等宽优先 ----------
const fontMenuEl = $('font-menu');
const fontSearchEl = $('font-search');
const fontListEl = $('font-list');
const MONO_HINT = /mono|consolas|courier|cascadia|code|fixed|terminal|menlo|ubuntu mono|dejavu sans mono/i;

function renderFontList(keyword = '') {
  const kw = keyword.trim().toLowerCase();
  const all = installedFonts.filter((f) => !kw || f.toLowerCase().includes(kw));
  const mono = all.filter((f) => MONO_HINT.test(f));
  const other = all.filter((f) => !MONO_HINT.test(f));
  fontListEl.innerHTML = '';

  if (!all.length) {
    const empty = document.createElement('div');
    empty.className = 'fp-empty';
    empty.textContent = installedFonts.length ? '没有匹配的字体' : '读取字体失败，可直接在输入框填写字体名';
    fontListEl.appendChild(empty);
    return;
  }

  const addItem = (name) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'fp-item' + (name === settings.font ? ' current' : '');
    const label = document.createElement('span');
    label.textContent = name;
    const sample = document.createElement('span');
    sample.className = 'fp-sample';
    sample.style.fontFamily = `"${name}"`;
    sample.textContent = 'Aa 123';
    item.append(label, sample);
    item.onclick = () => pickFont(name);
    fontListEl.appendChild(item);
  };

  if (mono.length) {
    const g = document.createElement('div');
    g.className = 'pop-group';
    g.textContent = '等宽字体';
    fontListEl.appendChild(g);
    mono.forEach(addItem);
  }
  if (other.length) {
    const g = document.createElement('div');
    g.className = 'pop-group';
    g.textContent = '其他字体';
    fontListEl.appendChild(g);
    other.slice(0, 200).forEach(addItem);
  }
}

function pickFont(name) {
  settings.font = normalizeFont(name);
  $('font-picker-name').textContent = settings.font;
  saveUiSettings();
  updateFontPreview();
  applyFontToAll();
  hideFontMenu();
}

function openFontMenu() {
  renderFontList('');
  fontSearchEl.value = '';
  $('font-picker').classList.add('open');
  showPopover(fontMenuEl, $('font-picker'), true);
  requestAnimationFrame(() => fontSearchEl.focus());
}

/// 浮层定位；matchWidth 时宽度与触发按钮一致。
/// 一律优先向下展开，下方空间不够就压缩自身高度（内部滚动），
/// 只有下方几乎没地方时才翻到上方——否则靠近窗口底部的下拉会莫名朝上开。
function showPopover(el, anchor, matchWidth = false, maxH = 560) {
  el.classList.remove('hidden');
  if (matchWidth) el.style.width = Math.round(anchor.getBoundingClientRect().width) + 'px';
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;

  const below = window.innerHeight - r.bottom - 14;
  const above = r.top - 14;
  const useBelow = below >= Math.min(maxH, 160);
  const avail = Math.max(120, useBelow ? below : above);
  el.style.maxHeight = Math.min(avail, maxH) + 'px';
  const h = el.offsetHeight;

  el.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - w - 12))) + 'px';
  el.style.top = Math.round(useBelow ? r.bottom + 6 : Math.max(8, r.top - h - 6)) + 'px';
}

function hideFontMenu() {
  fontMenuEl.classList.add('hidden');
  $('font-picker').classList.remove('open');
}

$('font-picker').onclick = (e) => {
  e.stopPropagation();
  if (fontMenuEl.classList.contains('hidden')) openFontMenu();
  else hideFontMenu();
};
fontSearchEl.oninput = () => renderFontList(fontSearchEl.value);
fontSearchEl.onkeydown = (e) => {
  if (e.key === 'Enter') {
    const first = fontListEl.querySelector('.fp-item');
    if (first) first.click();
    else if (fontSearchEl.value.trim()) pickFont(fontSearchEl.value.trim());
  } else if (e.key === 'Escape') {
    hideFontMenu();
  }
};

function applyFontToAll() {
  for (const s of sessions) {
    s.term.options.fontFamily = fontStack(settings.font);
    s.term.options.fontSize = settings.fontSize;
    s.fit.fit();
  }
}

function renderServerRows() {
  serverRowsEl.innerHTML = '';
  if (servers.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'row-empty';
    empty.textContent = '还没有服务器，点右上角「添加服务器」新建一台。';
    serverRowsEl.appendChild(empty);
    return;
  }
  const list = document.createElement('div');
  list.className = 'server-list';
  for (const srv of servers) list.appendChild(serverRow(srv));
  serverRowsEl.appendChild(list);
}

function serverRow(srv) {
  // 列表只读展示：名称 / 地址（含端口）/ 用户名 / 系统徽标 + 修改、删除
  const row = document.createElement('div');
  row.className = 'server-row';

  const icon = document.createElement('span');
  icon.className = 'srv-icon';
  const img = document.createElement('img');
  img.src = srv.os === 'windows' ? 'icons/laptop.svg' : 'icons/monitor.svg';
  img.alt = '';
  icon.appendChild(img);

  const main = document.createElement('div');
  main.className = 'srv-main';
  const name = document.createElement('span');
  name.className = 'srv-name';
  name.textContent = srv.name || srv.host;
  const sub = document.createElement('span');
  sub.className = 'srv-sub';
  sub.textContent = `${srv.user}@${srv.host}:${srv.port || 22}`;
  main.append(name, sub);

  const os = document.createElement('span');
  os.className = 'srv-os';
  os.textContent = osLabel(srv.os);

  const actions = document.createElement('div');
  actions.className = 'row-actions';

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'row-act';
  edit.textContent = '修改';
  edit.onclick = () => openServerModal(srv);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'row-act danger';
  del.textContent = '删除';
  let armed = false;
  let timer = null;
  del.onclick = () => {
    if (!armed) {
      armed = true;
      del.textContent = '确认删除';
      del.classList.add('armed');
      timer = setTimeout(() => {
        armed = false;
        del.textContent = '删除';
        del.classList.remove('armed');
      }, 2600);
      return;
    }
    clearTimeout(timer);
    removeServer(srv);
  };

  actions.append(edit, del);
  row.append(icon, main, os, actions);
  return row;
}

// ---------- 添加 / 编辑服务器弹窗 ----------
function openServerModal(server) {
  modalServer = server || null;
  $('server-modal-title').textContent = server ? '编辑服务器' : '添加服务器';
  $('m-name').value = server?.name || '';
  $('m-host').value = server?.host || '';
  // 新建时留空，不填就按 22 处理；编辑时回填已保存的端口
  $('m-port').value = server?.port ? String(server.port) : '';
  $('m-user').value = server?.user || '';
  $('m-password').value = server?.password || '';
  // 不再提供「自动检测」：必须明确选一个系统，否则远端列目录命令无法确定
  const os = server?.os && server.os !== 'auto' ? server.os : 'linux';
  $('m-os').value = os;
  $('m-error').classList.add('hidden');
  setModalBusy(false);
  serverModalEl.classList.remove('hidden');
  requestAnimationFrame(() => $('m-host').focus());
}

function closeServerModal() {
  if (modalSaving) return;
  serverModalEl.classList.add('hidden');
  modalServer = null;
}

function setModalBusy(busy) {
  modalSaving = busy;
  const btn = $('m-save');
  btn.disabled = busy;
  btn.textContent = busy ? '保存中…' : '保存';
}

async function submitServerModal() {
  if (modalSaving) return;
  const host = $('m-host').value.trim();
  const user = $('m-user').value.trim();
  if (!host || !user) {
    const err = $('m-error');
    err.textContent = '主机和用户名不能为空';
    err.classList.remove('hidden');
    return;
  }
  $('m-error').classList.add('hidden');

  // 端口留空默认 22；填了非法值就提示，不静默改成 22
  const portText = $('m-port').value.trim();
  const port = portText === '' ? 22 : parseInt(portText, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    const err = $('m-error');
    err.textContent = '端口需为 1–65535 之间的数字，留空则用 22';
    err.classList.remove('hidden');
    return;
  }

  const data = {
    id: modalServer?.id || 'srv-' + Date.now().toString(36),
    name: $('m-name').value.trim(),
    host,
    port,
    user,
    password: $('m-password').value,
    os: $('m-os').value,
    remote_path: modalServer?.remote_path || '',
  };

  setModalBusy(true);
  try {
    const i = servers.findIndex((s) => s.id === data.id);
    if (i >= 0) {
      Object.assign(servers[i], data);
      for (const s of sessions) if (s.server && s.server.id === data.id) s.server = servers[i];
    } else {
      servers.push(data);
    }
    await saveServers();
    serverModalEl.classList.add('hidden');
    modalServer = null;
  } catch (e) {
    const err = $('m-error');
    err.textContent = '保存失败：' + (e?.message || e);
    err.classList.remove('hidden');
  } finally {
    // 无论成功失败都要恢复按钮，否则会一直卡在「保存中…」
    setModalBusy(false);
  }
}

async function removeServer(srv) {
  const prev = servers;
  servers = servers.filter((s) => s.id !== srv.id);
  try {
    await saveServers();
  } catch (e) {
    servers = prev; // 写盘失败就回滚，避免界面显示删了、文件里还在
    renderAll();
    renderServerRows();
    alert('删除失败：' + (e?.message || e));
  }
}

/// 服务器配置实时写盘：写入 exe 同级的 ssh-tool.json
/// 写盘失败会抛出，由调用方提示用户（以前静默吞掉，用户以为存上了其实没存）
async function saveServers() {
  // 服务器配置变了（系统类型/地址），之前探测的家目录和位置列表可能不再成立
  remoteHomes.clear();
  remotePlaceCache.clear();
  if (tauriAvailable) await invoke('servers_save', { servers });
  renderAll();
  renderServerRows();
}

$('btn-server-add').onclick = () => openServerModal(null);
$('m-cancel').onclick = closeServerModal;
$('m-save').onclick = submitServerModal;

serverModalEl.addEventListener('mousedown', (e) => {
  if (e.target.classList.contains('modal-backdrop')) closeServerModal();
});
document.addEventListener('keydown', (e) => {
  if (serverModalEl.classList.contains('hidden')) return;
  if (e.key === 'Escape') { e.preventDefault(); closeServerModal(); }
  if (e.key === 'Enter' && e.target.tagName !== 'SELECT' && e.target.tagName !== 'BUTTON') {
    e.preventDefault();
    submitServerModal();
  }
});

// ---------- 外观：实时生效，实时保存 ----------
$('font-size').oninput = () => {
  const size = parseInt($('font-size').value, 10);
  settings.fontSize = size;
  $('font-size-val').textContent = size;
  saveUiSettings();
  updateFontPreview();
  applyFontToAll();
};

$('btn-settings').onclick = () => openSettings();
$('btn-about').onclick = () => openAbout();

// ---------- 「+」新建菜单 ----------
function menuItem(label, sub, icon, onClick) {
  const item = document.createElement('button');
  item.className = 'new-menu-item';
  const img = document.createElement('img');
  img.src = icon;
  img.alt = '';
  const text = document.createElement('span');
  text.className = 'new-menu-text';
  const strong = document.createElement('strong');
  strong.textContent = label;
  text.appendChild(strong);
  if (sub) {
    const small = document.createElement('small');
    small.textContent = sub;
    text.appendChild(small);
  }
  item.append(img, text);
  item.onclick = () => { hideNewMenu(); onClick(); };
  return item;
}

function menuSeparator() {
  const sep = document.createElement('div');
  sep.className = 'new-menu-sep';
  return sep;
}

function renderNewMenu() {
  newMenuEl.innerHTML = '';
  newMenuEl.appendChild(menuItem('PowerShell', '本机 · Windows PowerShell', 'icons/powershell.svg', () => newLocalSession('powershell')));
  newMenuEl.appendChild(menuItem('命令提示符', '本机 · cmd.exe', 'icons/terminal.svg', () => newLocalSession('cmd')));
  if (servers.length) {
    newMenuEl.appendChild(menuSeparator());
    const group = document.createElement('div');
    group.className = 'new-menu-group';
    group.textContent = 'SSH 终端';
    newMenuEl.appendChild(group);
    for (const srv of servers) {
      newMenuEl.appendChild(
        menuItem(srv.name || srv.host, `${srv.user}@${srv.host}`, 'icons/monitor.svg', () => openSshSession(srv))
      );
    }
  }
  newMenuEl.appendChild(menuSeparator());
  newMenuEl.appendChild(menuItem('管理服务器…', '打开设置页', 'icons/sliders.svg', () => openSettings()));
}

function openNewMenu() {
  renderNewMenu();
  newMenuEl.classList.remove('hidden');
  const r = btnTabAdd.getBoundingClientRect();
  newMenuEl.style.left = Math.round(r.left) + 'px';
  newMenuEl.style.top = Math.round(r.bottom + 6) + 'px';
}

function hideNewMenu() {
  newMenuEl.classList.add('hidden');
}

document.addEventListener('mousedown', (e) => {
  if (!newMenuEl.classList.contains('hidden') &&
      !newMenuEl.contains(e.target) && !btnTabAdd.contains(e.target)) {
    hideNewMenu();
  }
  if (!fontMenuEl.classList.contains('hidden') &&
      !fontMenuEl.contains(e.target) && !$('font-picker').contains(e.target)) {
    hideFontMenu();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideNewMenu();
    hideFontMenu();
  }
});
window.addEventListener('blur', () => { hideNewMenu(); hideFontMenu(); });

// ---------- 顶栏 / 全局 ----------
$('btn-tab-add').onclick = openNewMenu;
$('btn-local-ps').onclick = () => newLocalSession('powershell');
$('btn-local-cmd').onclick = () => newLocalSession('cmd');

async function loadServers() {
  if (!tauriAvailable) return;
  try {
    servers = (await invoke('servers_list')) || [];
  } catch {
    servers = [];
  }
}

if (tauriAvailable) {
  listen('term-data', (event) => {
    const { id, data } = event.payload;
    const s = resolveSession(id);
    if (s) s.term.write(b64decode(data));
  });
  listen('term-exit', (event) => markExited(event.payload.id));

  setInterval(() => {
    for (const s of sessions) {
      if (!s.alive || s.id < 0) continue;
      const t = s.term.options.title;
      if (t && t !== s.title && !t.startsWith('SSH Tool')) {
        s.title = cleanTitle(t);
        renderAll();
      }
    }
  }, 600);
}

function cleanTitle(raw) {
  let t = raw.trim();
  if (!t) return '终端';
  const last = t.split(/[\\/]/).pop();
  const name = last.replace(/\.(exe|EXE)$/, '');
  const short = name || '终端';
  return short.length > 26 ? short.slice(0, 25) + '…' : short;
}

window.addEventListener('resize', () => {
  if (settings.view !== 'term') return;
  const cur = sessions.find((x) => 'term:' + x.id === activeKey);
  if (cur && cur.id >= 0) {
    cur.fit.fit();
    invoke('term_resize', { id: cur.id, cols: cur.term.cols, rows: cur.term.rows }).catch(noop);
  }
});

// ---------- 启动 ----------
// 先读设置再读服务器，两个都到齐后一次性渲染（避免先按默认字体画一遍）
Promise.all([loadSettings(), loadServers()]).then(() => {
  $('font-picker-name').textContent = settings.font;
  $('font-size').value = settings.fontSize;
  $('font-size-val').textContent = settings.fontSize;
  updateFontPreview();
  renderAll();
});
updateWelcome();
