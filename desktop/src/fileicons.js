// 文件类型 → 图标映射（Material Icon Theme 的 SVG，按扩展名）。
// icons/ 目录下的 svg 都是 16x16。

const EXT_MAP = {
  // 编程语言
  py: 'python', pyw: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp',
  java: 'java',
  rs: 'rust',
  go: 'go',
  kt: 'kotlin', kts: 'kotlin',
  php: 'php',
  rb: 'ruby',
  swift: 'swift',
  lua: 'lua',
  pl: 'perl', pm: 'perl',
  // 前端
  html: 'html', htm: 'html',
  css: 'css', scss: 'css', less: 'css',
  vue: 'html',
  // 数据/配置
  json: 'json',
  yaml: 'yaml', yml: 'yaml',
  xml: 'xml', svg: 'xml',
  toml: 'toml',
  ini: 'toml', conf: 'toml', cfg: 'toml',
  sql: 'database', db: 'database', sqlite: 'database',
  // 文档
  md: 'markdown', markdown: 'markdown',
  tex: 'tex', sty: 'tex', cls: 'tex',
  txt: 'document', text: 'document',
  log: 'log',
  pdf: 'pdf',
  doc: 'word', docx: 'word',
  ppt: 'powerpoint', pptx: 'powerpoint',
  xls: 'table', xlsx: 'table', csv: 'table', tsv: 'table',
  license: 'license',
  readme: 'readme',
  // 脚本
  sh: 'shellcheck', bash: 'shellcheck', zsh: 'shellcheck',
  ps1: 'powershell', psm1: 'powershell',
  bat: 'powershell', cmd: 'powershell',
  // 工程
  gitignore: 'git', gitattributes: 'git',
  // 二进制/媒体
  exe: 'exe', dll: 'exe', msi: 'exe', app: 'exe', deb: 'exe', rpm: 'exe', appimage: 'exe',
  zip: 'zip', '7z': 'zip', rar: 'zip', gz: 'zip', tar: 'zip', bz2: 'zip', xz: 'zip',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image',
  mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', m4a: 'audio',
  mp4: 'video', mkv: 'video', avi: 'video', mov: 'video', webm: 'video',
};

export function iconForFile(name, isDir) {
  if (isDir) return 'icons/folder.svg';
  const lower = name.toLowerCase();
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'icons/docker.svg';
  if (lower === 'license' || lower.startsWith('license.')) return 'icons/license.svg';
  if (lower === 'readme' || lower.startsWith('readme.')) return 'icons/readme.svg';
  if (lower.startsWith('.gitignore') || lower.startsWith('.git')) return 'icons/git.svg';
  if (lower.startsWith('makefile')) return 'icons/document.svg';
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  const icon = EXT_MAP[ext];
  return icon ? `icons/${icon}.svg` : 'icons/document.svg';
}

export function typeLabel(name, isDir) {
  if (isDir) return '文件夹';
  const ext = name.toLowerCase().includes('.')
    ? name.slice(name.lastIndexOf('.') + 1).toUpperCase()
    : '文件';
  return ext.length <= 6 ? ext + ' 文件' : '文件';
}
