# SSH Tool

一个 Windows 上的轻量 SSH 客户端：内置终端 + 双栏文件传输，界面浅色、终端深色。

## 特性

- **多目标系统**：可连接 Linux、macOS、Windows 三类主机，远端列目录命令按所选系统自动切换。
- **终端**：基于 xterm.js，支持多标签、SSH 密码登录与本机 PowerShell / CMD。
- **文件传输**：左侧本机、右侧服务器双栏浏览，勾选后左右互传；远端默认落在当前用户家目录。
- **本机存储**：服务器配置与密码只写入本机的 `servers.json`，不上传任何服务，也没有账号或令牌。
- **外观**：终端字体取本机已安装字体，字号可调，设置实时生效、无需保存。

## 环境

- Windows 10 / 11
- 本机需有 OpenSSH 客户端（`ssh.exe`、`scp.exe`，Windows 可选功能里自带）
- 从源码构建需要 Rust 工具链与 Tauri 2 的 Windows 依赖

## 构建

```powershell
cd desktop/src-tauri
cargo build            # 调试构建
cargo build --release  # 发布构建
```

前端是 `desktop/src` 下的原生 HTML/CSS/JS，由 Tauri 在编译期直接嵌入，改完前端也需要重新 `cargo build`。

## 目录

```
desktop/
  src/            前端：index.html / app.js / style.css / icons
  src-tauri/      Rust：main.rs、pty.rs（终端）、ssh.rs（远程命令）、transfer.rs（传输）、config.rs（配置与浏览）
_archive/         早期 egui 原型，仅作历史参考
```

## 许可

第三方组件：Tauri 2（MIT / Apache-2.0）、xterm.js（MIT）、portable-pty（MIT）、Material Icon Theme（MIT）。
