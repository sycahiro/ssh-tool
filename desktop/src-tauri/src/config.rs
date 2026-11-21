//! 服务器配置持久化 + 本地/远程文件浏览 + 传输取消注册表。
//!
//! 配置存在 app data 目录的 servers.json（含密码，文件权限收紧；
//! 后续可换系统凭据管理器）。

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::ssh::{self, FileEntry};

#[derive(Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub password: String,
    /// "linux" | "windows" | "auto"
    #[serde(default)]
    pub os: String,
    #[serde(default)]
    pub remote_path: String,
}

fn default_port() -> u16 {
    22
}

#[derive(Default, Clone, Serialize, Deserialize)]
struct Store {
    servers: Vec<ServerConfig>,
}

static CANCELS: OnceLock<Mutex<HashMap<u32, Arc<AtomicBool>>>> = OnceLock::new();
static STORE_CACHE: OnceLock<Mutex<Store>> = OnceLock::new();
static FONTS: OnceLock<Vec<String>> = OnceLock::new();

/// 列出 Windows 已安装的字体族，供设置页的终端字体选择。
/// 不再内置字体文件，用户装了什么就用什么。
#[tauri::command]
pub fn installed_fonts() -> Vec<String> {
    FONTS
        .get_or_init(|| {
            let script = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
                          Add-Type -AssemblyName System.Drawing; \
                          (New-Object System.Drawing.Text.InstalledFontCollection).Families \
                          | ForEach-Object { $_.Name }";
            let mut cmd = std::process::Command::new("powershell");
            cmd.args(["-NoProfile", "-NonInteractive", "-Command", script])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            let mut list: Vec<String> = cmd
                .output()
                .ok()
                .map(|out| {
                    String::from_utf8_lossy(&out.stdout)
                        .lines()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            list.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
            list.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
            list
        })
        .clone()
}

pub fn register_cancel(id: u32, flag: Arc<AtomicBool>) {
    CANCELS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(id, flag);
}

pub fn unregister_cancel(id: u32) {
    if let Some(m) = CANCELS.get() {
        m.lock().unwrap().remove(&id);
    }
}

pub fn take_cancel(id: u32) -> Option<Arc<AtomicBool>> {
    CANCELS.get()?.lock().unwrap().get(&id).cloned()
}

fn store_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("servers.json"))
}

fn load(app: &tauri::AppHandle) -> Result<Store, String> {
    let path = store_path(app)?;
    if let Ok(text) = std::fs::read_to_string(&path) {
        serde_json::from_str(&text).map_err(|e| e.to_string())
    } else {
        Ok(Store::default())
    }
}

fn save(app: &tauri::AppHandle, store: &Store) -> Result<(), String> {
    let path = store_path(app)?;
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// transfer 线程没有 AppHandle：读全局缓存（每个带 app 的命令入口刷新）。
pub fn find_server(id: &str) -> Result<ssh::Server, String> {
    let store = STORE_CACHE.get_or_init(Default::default).lock().unwrap();
    let s = store
        .servers
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("服务器 {id} 不存在（请先保存配置）"))?;
    Ok(ssh::Server {
        host: s.host.clone(),
        port: s.port,
        user: s.user.clone(),
        password: s.password.clone(),
        os: if s.os == "auto" || s.os.is_empty() {
            "linux".into()
        } else {
            s.os.clone()
        },
    })
}

/// 每个命令入口刷新缓存（保证 transfer 线程用的是最新配置）。
fn refresh_cache(app: &tauri::AppHandle) -> Result<Store, String> {
    let store = load(app)?;
    *STORE_CACHE.get_or_init(Default::default).lock().unwrap() = store.clone();
    Ok(store)
}

#[tauri::command]
pub fn servers_list(app: tauri::AppHandle) -> Result<Vec<ServerConfig>, String> {
    Ok(refresh_cache(&app)?.servers)
}

#[tauri::command]
pub fn servers_save(app: tauri::AppHandle, servers: Vec<ServerConfig>) -> Result<(), String> {
    let store = Store { servers };
    save(&app, &store)?;
    *STORE_CACHE.get_or_init(Default::default).lock().unwrap() = store;
    Ok(())
}

#[derive(Serialize)]
pub struct BrowseResult {
    pub path: String,
    pub parent: Option<String>,
    /// 远端用户的默认目录（仅在前端首次解析时返回，用于「位置」菜单）
    pub home: Option<String>,
    pub entries: Vec<FileEntry>,
    pub error: Option<String>,
}

fn split_path(path: &str) -> (String, Option<String>) {
    let trimmed = path.trim_end_matches('/').replace('\\', "/");
    if trimmed.is_empty() {
        return ("/".into(), None);
    }
    let parent = match trimmed.rfind('/') {
        Some(0) => Some("/".to_string()),
        Some(i) => Some(trimmed[..i].to_string()),
        None => None,
    };
    (trimmed, parent)
}

#[tauri::command]
pub fn browse_local(path: String) -> BrowseResult {
    // "D:" 在 Windows 上指“D 盘当前目录”，不是盘根；统一成 "D:\"
    let mut path = path.trim().to_string();
    let bytes = path.as_bytes();
    if bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        path.push('\\');
    }
    let mut result = BrowseResult {
        path: path.clone(),
        parent: None,
        home: None,
        entries: Vec::new(),
        error: None,
    };
    let dir = std::path::Path::new(&path);
    let (full, parent) = split_path(&path);
    result.parent = parent;
    let _ = full;
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            result.error = Some(e.to_string());
            return result;
        }
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let size = if meta.is_dir() { 0 } else { meta.len() };
        // mtime 输出 epoch 秒，前端用 new Date() 本地化渲染
        let mtime = meta
            .modified()
            .ok()
            .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs().to_string())
            .unwrap_or_default();
        result.entries.push(FileEntry {
            name,
            is_dir: meta.is_dir(),
            size,
            mtime,
        });
    }
    result.entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    result
}

#[tauri::command]
pub fn browse_remote(app: tauri::AppHandle, server_id: String, path: String) -> BrowseResult {
    let mut result = BrowseResult {
        path: path.clone(),
        parent: None,
        home: None,
        entries: Vec::new(),
        error: None,
    };

    let server = match config_server(&app, &server_id) {
        Ok(s) => s,
        Err(e) => {
            result.error = Some(e);
            return result;
        }
    };

    // 空路径 = 还没选过目录：落到当前用户的家目录，
    // Linux/macOS 下普通用户通常看不到别的用户目录，从 / 开始并不好用。
    let mut start = path.trim().to_string();
    if start.is_empty() {
        start = home_dir(&server).unwrap_or_default();
        if start.is_empty() {
            start = if server.os == "windows" { "C:/Users".into() } else { "/".into() };
        }
        result.home = Some(start.clone());
    }
    result.path = start.clone();
    let (_, parent) = split_path(&start);
    result.parent = parent;
    let path = start;

    let cmd = ssh::remote_list_command(&server.os, &path);
    match ssh::run_remote(&server, &cmd) {
        Ok(out) => {
            result.entries = if server.os == "windows" {
                ssh::parse_ps(&out)
            } else {
                // stat/find 的 `类型|大小|epoch|名字`；解析不出内容时再按 ls -la 兜底
                let parsed = ssh::parse_stat(&out);
                if parsed.is_empty() && out.contains("total ") {
                    ssh::parse_ls(&out)
                } else {
                    parsed
                }
            };
        }
        Err(e) => result.error = Some(e),
    }
    result
}

fn config_server(app: &tauri::AppHandle, id: &str) -> Result<ssh::Server, String> {
    let store = refresh_cache(app)?;
    let s = store
        .servers
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("服务器 {id} 不存在"))?;
    Ok(ssh::Server {
        host: s.host.clone(),
        port: s.port,
        user: s.user.clone(),
        password: s.password.clone(),
        os: if s.os == "auto" || s.os.is_empty() {
            "linux".into()
        } else {
            s.os.clone()
        },
    })
}

/// 远端当前用户的家目录。
fn home_dir(server: &ssh::Server) -> Option<String> {
    if server.os == "windows" {
        let out = ssh::run_remote(server, "cmd /c echo %USERPROFILE%").ok()?;
        let v = out
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .last()?
            .replace('\\', "/");
        return if v.is_empty() { None } else { Some(v) };
    }
    // 登录横幅可能出现在前面，只认以 / 开头的行；$HOME 取不到时 pwd 兜底
    let out = ssh::run_remote(server, "echo $HOME; pwd").ok()?;
    for line in out.lines().map(str::trim) {
        if line.starts_with('/') {
            return Some(line.to_string());
        }
    }
    None
}

/// 远端驱动器列表（Windows 目标）：运行时探测，不写死 C 盘。
fn windows_drives(server: &ssh::Server) -> Vec<String> {
    let cmd = "powershell -NoProfile -Command \"Get-PSDrive -PSProvider FileSystem | \
               Select-Object -ExpandProperty Root\"";
    let out = match ssh::run_remote(server, cmd) {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let mut drives: Vec<String> = out
        .lines()
        .map(str::trim)
        .filter(|l| l.len() == 3 && l.ends_with(":\\"))
        .map(|l| format!("{}/", l[..2].to_uppercase()))
        .collect();
    drives.sort();
    drives.dedup();
    drives
}

/// 文件传输弹窗里远端的「常用位置」，按目标系统生成：
/// Linux/macOS 没有盘符，普通用户也看不到别人家目录；Windows 则现场探测驱动器。
#[tauri::command]
pub fn remote_places(app: tauri::AppHandle, server_id: String) -> Result<Vec<Place>, String> {
    let server = config_server(&app, &server_id)?;
    let mut out: Vec<Place> = Vec::new();
    if let Some(home) = home_dir(&server) {
        out.push(Place {
            label: "用户目录".into(),
            path: home,
            kind: "home".into(),
        });
    }
    if server.os == "windows" {
        for d in windows_drives(&server) {
            out.push(Place {
                label: d.trim_end_matches('/').to_string(),
                path: d,
                kind: "drive".into(),
            });
        }
    } else {
        out.push(Place {
            label: "根目录 /".into(),
            path: "/".into(),
            kind: "drive".into(),
        });
        if server.os != "macos" {
            out.push(Place {
                label: "临时目录 /tmp".into(),
                path: "/tmp".into(),
                kind: "folder".into(),
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn local_mkdir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remote_mkdir(app: tauri::AppHandle, server_id: String, path: String) -> Result<(), String> {
    let server = config_server(&app, &server_id)?;
    let cmd = ssh::remote_mkdir_command(&server.os, &path);
    ssh::run_remote(&server, &cmd).map(|_| ())
}

/// 本地默认目录（文件面板初始位置）。
#[tauri::command]
pub fn local_home() -> String {
    dirs_home().unwrap_or_else(|| ".".to_string())
}

/// 文件面板「位置」菜单：所有盘符 + 常用文件夹。
#[derive(Serialize)]
pub struct Place {
    pub label: String,
    pub path: String,
    /// "drive" | "home" | "folder"
    pub kind: String,
}

#[tauri::command]
pub fn local_places() -> Vec<Place> {
    let mut out: Vec<Place> = Vec::new();
    if let Some(home) = dirs_home() {
        out.push(Place {
            label: "用户目录".into(),
            path: home.clone(),
            kind: "home".into(),
        });
        for (label, name) in [
            ("桌面", "Desktop"),
            ("文档", "Documents"),
            ("下载", "Downloads"),
            ("图片", "Pictures"),
            ("视频", "Videos"),
            ("音乐", "Music"),
        ] {
            let p = std::path::Path::new(&home).join(name);
            if p.is_dir() {
                out.push(Place {
                    label: label.into(),
                    path: p.to_string_lossy().to_string(),
                    kind: "folder".into(),
                });
            }
        }
    }
    for c in b'A'..=b'Z' {
        let p = format!("{}:\\", c as char);
        if std::path::Path::new(&p).exists() {
            out.push(Place {
                label: format!("{}:", c as char),
                path: p,
                kind: "drive".into(),
            });
        }
    }
    out
}

fn dirs_home() -> Option<String> {
    std::env::var("USERPROFILE").ok()
}
