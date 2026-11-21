//! PTY 会话管理：把 portable-pty 接到 Tauri 事件系统。
//!
//! 数据流：
//!   xterm.js ──invoke(term_write)──▶ Writer ──▶ PTY ──▶ shell/ssh
//!   PTY ──▶ reader 线程 ──emit("term-data")──▶ xterm.js
//!
//! 字节流用 base64 传输（Tauri 事件走 JSON，不能直接放二进制）。

use std::collections::HashMap;
use std::io::Read;
use std::sync::Mutex;

use base64::Engine as _;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, State};

/// 单个终端会话的后端句柄。
struct Session {
    /// PTY 写入端（前端输入与密码应答共用一把锁）
    writer: std::sync::Arc<Mutex<Box<dyn std::io::Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    /// 子进程是否已退出（reader EOF 时置位）
    exited: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<u32, Session>>,
    pty_system: Mutex<Option<Box<dyn portable_pty::PtySystem + Send>>>,
}

#[derive(Clone, serde::Serialize)]
struct DataPayload {
    id: u32,
    data: String, // base64
}

#[derive(Clone, serde::Serialize)]
struct ExitPayload {
    id: u32,
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

static NEXT_SESSION: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

/// 启动一个进程。program 例：powershell / ssh。
/// 会话 id 由后端分配并返回：前端刷新后旧会话已销毁，不会撞号误报「已退出」。
#[tauri::command]
pub fn term_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    program: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    spawn_inner(app, state, program, args, cols, rows, None)
}

/// 实际启动。password 只在 ssh 会话里传入，不再经过全局共享状态，
/// 避免并发开多个 SSH 终端时互相拿错密码。
fn spawn_inner(
    app: AppHandle,
    state: State<'_, PtyState>,
    program: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
    password: Option<String>,
) -> Result<u32, String> {
    let id = NEXT_SESSION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut guard = state.pty_system.lock().unwrap();
    let system = guard.get_or_insert_with(native_pty_system);

    let pair = system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&program);
    for a in &args {
        cmd.arg(a);
    }
    // 明确声明 UTF-8，避免 Windows 控制台代码页把中文变成乱码
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    // ssh 会话优先走 askpass（和文件浏览同一套已验证的密码注入），
    // SSH_ASKPASS_REQUIRE=force 即使有 TTY 也会使用；旧系统不支持时
    // 下方 reader 线程的提示符检测仍会兜底。
    let password_for_reader = password.filter(|_| program == "ssh");
    let _askpass_path = if let Some(pw) = password_for_reader.as_deref() {
        match crate::ssh::write_askpass() {
            Ok(path) => {
                let path_str = path.to_string_lossy().to_string();
                cmd.env("SSH_ASKPASS", &path_str);
                cmd.env("SSH_ASKPASS_REQUIRE", "force");
                cmd.env("SSHTOOL_PW", pw);
                Some(path)
            }
            Err(_) => None,
        }
    } else {
        None
    };

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动 {program} 失败: {e}"))?;
    drop(pair.slave);

    let master = pair.master;
    let mut reader = master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = std::sync::Arc::new(Mutex::new(
        master.take_writer().map_err(|e| e.to_string())?,
    ));

    let exited = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    // 读线程：PTY 输出 → 前端（ssh 会话顺带做密码提示符检测，作为 askpass 的兜底）
    {
        let app = app.clone();
        let exited = exited.clone();
        let is_ssh = password_for_reader.is_some();
        let password = password_for_reader;
        let writer_for_answer = writer.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            // 保留尾部一小段，跨 read 边界匹配提示符
            let mut tail: Vec<u8> = Vec::new();
            let mut answers_left = 3; // 密码错会再问，最多应答 3 次
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if is_ssh && answers_left > 0 {
                            tail.extend_from_slice(&buf[..n]);
                            if tail.len() > 4096 {
                                tail.drain(..tail.len() - 4096);
                            }
                            // 逐字节找 "password:"，之后允许 \r 或空格，不能有 \n
                            if let Ok(text) = std::str::from_utf8(&tail) {
                                if let Some(p) = text.rfind("password:") {
                                    let after = &text[p + "password:".len()..];
                                    let waiting = after.chars().all(|c| c == '\r' || c == ' ');
                                    if waiting {
                                        answers_left -= 1;
                                        let mut w = writer_for_answer.lock().unwrap();
                                        let _ = w.write_all(password.as_deref().unwrap_or("").as_bytes());
                                        let _ = w.write_all(b"\r");
                                        let _ = w.flush();
                                        tail.clear();
                                    }
                                }
                            }
                        }
                        let _ = app.emit(
                            "term-data",
                            DataPayload {
                                id,
                                data: b64(&buf[..n]),
                            },
                        );
                    }
                }
            }
            exited.store(true, std::sync::atomic::Ordering::Relaxed);
            let _ = app.emit("term-exit", ExitPayload { id });
        });
    }

    // 子进程回收线程（避免僵尸进程；退出后 close 由前端触发）
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });

    state.sessions.lock().unwrap().insert(
        id,
        Session {
            writer,
            master,
            exited,
        },
    );
    Ok(id)
}

/// 前端键盘/粘贴输入 → PTY。
#[tauri::command]
pub fn term_write(
    state: State<'_, PtyState>,
    id: u32,
    data: String,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| e.to_string())?;
    let sessions = state.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("会话不存在")?;
    let mut w = session.writer.lock().unwrap();
    w.write_all(&bytes).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

/// xterm.js 尺寸变化 → PTY 窗口大小。
#[tauri::command]
pub fn term_resize(state: State<'_, PtyState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("会话不存在")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_close(state: State<'_, PtyState>, id: u32) -> Result<(), String> {
    // 移除即 drop：关闭 PTY 主端，子进程收到 SIGHUP/控制台销毁。
    state.sessions.lock().unwrap().remove(&id);
    Ok(())
}

#[tauri::command]
pub fn term_is_alive(state: State<'_, PtyState>, id: u32) -> bool {
    state
        .sessions
        .lock()
        .unwrap()
        .get(&id)
        .map(|s| !s.exited.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false)
}

/// 本机默认 shell（客户端只跑 Windows）。
#[tauri::command]
pub fn default_shell() -> (String, Vec<String>) {
    ("powershell.exe".into(), vec![])
}

/// 打开一个远程服务器的 ssh 终端会话：把服务器密码暂存给应答器，
/// 然后走普通 PTY spawn 启动 ssh.exe。
#[tauri::command]
pub fn ssh_session(
    app: AppHandle,
    state: State<'_, PtyState>,
    host: String,
    port: u16,
    user: String,
    password: String,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    let program = crate::ssh::ssh_exe();
    let args = vec![
        "-o".to_string(),
        "PreferredAuthentications=password".to_string(),
        "-o".to_string(),
        "NumberOfPasswordPrompts=1".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
        "-p".to_string(),
        port.to_string(),
        format!("{user}@{host}"),
    ];
    spawn_inner(app, state, program.to_string(), args, cols, rows, Some(password))
}
