//! SSH/scp 公共工具：askpass 密码注入、远程列目录解析。
//!
//! 密码只通过环境变量传给子进程（临时 askpass 脚本 echo 该变量），
//! 绝不出现在命令行参数、日志或事件里。

pub struct Server {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub os: String, // "linux" | "macos" | "windows"
}

/// ssh 可执行文件（三端都叫 ssh，PATH 里都能找到）。
pub fn ssh_exe() -> &'static str {
    "ssh"
}

pub fn ssh_target(s: &Server) -> String {
    format!("{}@{}", s.user, s.host)
}

/// 写一个临时 askpass 批处理（客户端只跑 Windows），返回路径。
/// 密码留在调用方进程环境里。
pub fn write_askpass() -> Result<std::path::PathBuf, String> {
    let path = std::env::temp_dir().join("sshtool-askpass.cmd");
    std::fs::write(&path, "@echo off\r\necho %SSHTOOL_PW%\r\n").map_err(|e| e.to_string())?;
    Ok(path)
}

/// 给 Command 设置 ssh/scp 需要的环境变量（含密码，仅本进程可见）。
pub fn apply_env(cmd: &mut std::process::Command, askpass: &str, password: &str) {
    cmd.env("SSH_ASKPASS", askpass)
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env("SSHTOOL_PW", password);
}

/// 远程路径的 shell 安全引用。
pub fn quote_remote(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\\''"))
}

/// 远程列目录命令。
///
/// 两边都输出 epoch 秒，由前端统一按本地时区格式化：
/// `ls -la` 的日期列受远端 locale 影响（会变成「4月 2 2026」这种），
/// 也不带时区信息，所以 Linux/macOS 用 stat 自己取。
pub fn remote_list_command(os: &str, path: &str) -> String {
    let p = quote_remote(path);
    if os == "windows" {
        format!(
            "powershell -NoProfile -Command \"Get-ChildItem -Force -LiteralPath '{path}' | ForEach-Object {{ \\\"$($_.PSIsContainer)|$($_.Length)|$([int][double]::Parse((Get-Date $_.LastWriteTime -UFormat %s)))|$($_.Name)\\\" }}\""
        )
    } else {
        if os == "macos" {
            // BSD stat：%Sp 权限串（首字符 d 为目录），%N 带 ./ 前缀
            format!(
                "cd {p} && find . -maxdepth 1 -mindepth 1 -exec stat -f '%Sp|%z|%m|%N' {{}} + 2>/dev/null"
            )
        } else {
            format!(
                "cd {p} && find . -maxdepth 1 -mindepth 1 -printf '%y|%s|%T@|%f\\n' 2>/dev/null"
            )
        }
    }
}

/// 远程建目录（Windows 目标用 PowerShell，Linux/macOS 用 mkdir -p）。
pub fn remote_mkdir_command(os: &str, path: &str) -> String {
    if os == "windows" {
        let escaped = path.replace('\'', "''").replace('\\', "/");
        format!(
            "powershell -NoProfile -Command \"New-Item -ItemType Directory -Force -LiteralPath '{escaped}' | Out-Null\""
        )
    } else {
        format!("mkdir -p {}", quote_remote(path))
    }
}

#[derive(Clone, serde::Serialize)]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: String,
}

/// 解析 `find -printf '%y|%s|%T@|%f'` / BSD `stat` 输出：`类型|大小|mtime|名字`。
/// 类型首字符 d 为目录；mtime 可能是 `1712345678.1234567890` 这种带小数的 epoch 秒。
pub fn parse_stat(output: &str) -> Vec<FileEntry> {
    let mut entries = Vec::new();
    for line in output.lines() {
        let cols: Vec<&str> = line.splitn(4, '|').collect();
        if cols.len() != 4 {
            continue;
        }
        // BSD stat 的 %N 带 "./" 前缀
        let name = cols[3].trim().trim_start_matches("./").to_string();
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        let mtime = cols[2]
            .trim()
            .split('.')
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        entries.push(FileEntry {
            name,
            is_dir: cols[0].trim().starts_with('d'),
            size: cols[1].trim().parse().unwrap_or(0),
            mtime,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

/// 解析 `ls -la` 输出（stat 不可用时的兜底）。
pub fn parse_ls(output: &str) -> Vec<FileEntry> {
    let mut entries = Vec::new();
    for line in output.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 9 {
            continue; // total/表头/异常行
        }
        let name = parts[8..].join(" ");
        if name == "." || name == ".." {
            continue;
        }
        let perms = parts[0];
        let is_dir = perms.starts_with('d');
        let size: u64 = parts[4].parse().unwrap_or(0);
        entries.push(FileEntry {
            name,
            is_dir,
            size,
            mtime: format!("{} {} {}", parts[5], parts[6], parts[7]),
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

/// 解析 PowerShell 输出（`type|size|date|name`）。
pub fn parse_ps(output: &str) -> Vec<FileEntry> {
    let mut entries = Vec::new();
    for line in output.lines() {
        let cols: Vec<&str> = line.splitn(4, '|').collect();
        if cols.len() != 4 {
            continue;
        }
        entries.push(FileEntry {
            name: cols[3].trim().to_string(),
            is_dir: cols[0].trim() == "True",
            size: cols[1].trim().parse().unwrap_or(0),
            mtime: cols[2].trim().to_string(),
        });
    }
    entries
}

/// 非交互执行远程命令（ssh + askpass）。返回 stdout。
pub fn run_remote(server: &Server, command: &str) -> Result<String, String> {
    let askpass = write_askpass()?;
    let mut cmd = std::process::Command::new("ssh");
    apply_env(&mut cmd, &askpass.to_string_lossy(), &server.password);
    cmd.args([
        "-o",
        "PreferredAuthentications=password",
        "-o",
        "NumberOfPasswordPrompts=1",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-p",
        &server.port.to_string(),
        &ssh_target(server),
        command,
    ])
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let out = cmd.output().map_err(|e| format!("无法启动 ssh: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let real: Vec<&str> = err
            .lines()
            .filter(|l| !l.contains("post-quantum") && !l.contains("store now") && !l.contains("upgraded"))
            .collect();
        return Err(if real.is_empty() {
            "远程命令失败".into()
        } else {
            real.join("; ")
        });
    }
    Ok(stdout)
}
