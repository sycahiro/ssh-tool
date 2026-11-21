# SSH Tool

一个 Windows 上的轻量 SSH 客户端：内置终端 + 双栏文件传输，界面浅色、终端深色。

## 快速开始

**双击 `启动.cmd`** 即可编译并运行（首次编译需要几分钟，之后是秒级）。

或者用命令行：

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1      # 调试构建并启动
powershell -ExecutionPolicy Bypass -File .\build.ps1    # 发布构建，产物在 dist\SSH-Tool.exe
```

`build.ps1` 产出的 `dist\SSH-Tool.exe` 是单文件，前端资源已内嵌，拷到任何地方双击都能跑，不依赖源码目录。

## 特性

- **多目标系统**：可连接 Linux、macOS、Windows 三类主机，远端列目录命令按所选系统切换。
- **终端**：基于 xterm.js，支持多标签、SSH 密码登录与本机 PowerShell / CMD。
- **文件传输**：左侧本机、右侧服务器双栏浏览，勾选后左右互传；远端默认落在当前用户家目录。
- **便携存储**：所有配置（服务器、密码、字体、字号、上次目录）写进 exe 同级的单个 `ssh-tool.json`，不上传任何服务，也没有账号或令牌。把 exe 和这个文件一起拷走就完成了迁移；exe 所在目录不可写时（例如装在 `Program Files`）自动改用 `%APPDATA%\com.wywan.ssh-tool\`。
- **外观**：终端字体取本机已安装字体，字号可调，设置实时生效、无需保存。

## 环境要求

- Windows 10 / 11
- 本机需有 OpenSSH 客户端（`ssh.exe`、`scp.exe`，Windows 可选功能里自带）
- 从源码构建需要 Rust 工具链（`cargo`）和 Tauri 2 的 Windows 依赖（WebView2）

## 目录

```
启动.cmd            双击启动
run.ps1             调试构建 + 启动
build.ps1           发布构建 → dist\SSH-Tool.exe
desktop/
  src/              前端：index.html / app.js / style.css / icons
  src-tauri/        Rust：main.rs、pty.rs（终端）、ssh.rs（远程命令）、
                    transfer.rs（传输）、config.rs（配置与浏览）
```

前端是原生 HTML/CSS/JS，由 Tauri 在编译期嵌入，所以改完前端也需要重新编译。

## 许可

第三方组件：Tauri 2（MIT / Apache-2.0）、xterm.js（MIT）、portable-pty（MIT）、Material Icon Theme（MIT）。
