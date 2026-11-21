//! scp 传输：后台进程 + stderr 进度解析 → 事件推给前端。

use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::config;
use crate::ssh;

static NEXT_TRANSFER: AtomicU32 = AtomicU32::new(1);

#[derive(Clone, Serialize)]
struct ProgressPayload {
    id: u32,
    percent: f64,
    done: bool,
    error: Option<String>,
}

/// direction: "up" | "down"
#[tauri::command]
pub fn transfer(
    app: AppHandle,
    server_id: String,
    direction: String,
    paths: Vec<String>,
    dest: String,
) -> Result<u32, String> {
    let server = config::find_server(&server_id)?;
    let id = NEXT_TRANSFER.fetch_add(1, Ordering::Relaxed);
    let cancelled = Arc::new(AtomicBool::new(false));
    config::register_cancel(id, cancelled.clone());

    std::thread::spawn(move || {
        let result = run_transfer(&app, id, &server, &direction, &paths, &dest, &cancelled);
        let (percent, error) = match result {
            Ok(()) => (100.0, None),
            Err(e) => (0.0, Some(e)),
        };
        let _ = app.emit(
            "transfer-progress",
            ProgressPayload {
                id,
                percent,
                done: true,
                error,
            },
        );
        config::unregister_cancel(id);
    });
    Ok(id)
}

#[tauri::command]
pub fn transfer_cancel(id: u32) {
    if let Some(flag) = config::take_cancel(id) {
        flag.store(true, Ordering::Relaxed);
    }
}

fn run_transfer(
    app: &AppHandle,
    id: u32,
    server: &ssh::Server,
    direction: &str,
    paths: &[String],
    dest: &str,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let askpass = ssh::write_askpass()?;
    let mut cmd = std::process::Command::new("scp");
    ssh::apply_env(&mut cmd, &askpass.to_string_lossy(), &server.password);
    cmd.args([
        "-r",
        "-o",
        "PreferredAuthentications=password",
        "-o",
        "NumberOfPasswordPrompts=1",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-P",
        &server.port.to_string(),
    ]);
    if direction == "up" {
        for p in paths {
            cmd.arg(p);
        }
        let mkdir = ssh::remote_mkdir_command(&server.os, dest);
        let _ = ssh::run_remote(server, &mkdir);
        // 保留绝对路径；Windows 目标统一用正斜杠（OpenSSH/SFTP 接受盘符路径）
        let remote_dest = if server.os == "windows" {
            dest.replace('\\', "/")
        } else {
            dest.to_string()
        };
        let remote = format!("{}:{}", ssh::ssh_target(server), remote_dest);
        cmd.arg(remote);
    } else {
        let base = ssh::ssh_target(server);
        for p in paths {
            let remote_path = if server.os == "windows" {
                p.replace('\\', "/")
            } else {
                p.clone()
            };
            cmd.arg(format!("{base}:{remote_path}"));
        }
        cmd.arg(dest);
    }
    cmd.stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| format!("无法启动 scp: {e}"))?;
    let mut stderr = child.stderr.take().unwrap();

    let mut buf = [0u8; 4096];
    let mut tail = String::new();
    let mut last_emit = std::time::Instant::now();

    loop {
        if cancelled.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("已取消".into());
        }
        let n = stderr.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
        for piece in chunk.split(['\r', '\n']) {
            if !piece.is_empty() {
                tail = piece.to_string();
            }
        }
        if let Some(pct) = parse_percent(&tail) {
            if last_emit.elapsed().as_millis() >= 120 {
                last_emit = std::time::Instant::now();
                let _ = app.emit(
                    "transfer-progress",
                    ProgressPayload {
                        id,
                        percent: pct,
                        done: false,
                        error: None,
                    },
                );
            }
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("传输失败（scp 退出码非 0）".into());
    }
    Ok(())
}

fn parse_percent(line: &str) -> Option<f64> {
    // 形如 "file.txt      45%  1.2MB  3.4MB/s   00:03"
    let idx = line.find('%')?;
    let num: f64 = line[..idx]
        .rsplit(|c: char| c.is_whitespace())
        .next()?
        .parse()
        .ok()?;
    Some(num)
}
