#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod pty;
mod ssh;
mod transfer;

fn main() {
    tauri::Builder::default()
        .manage(pty::PtyState::default())
        .setup(|app| {
            // 代码建窗：可以关掉 devtools（避免 F12/Ctrl+Shift+I），
            // 右键菜单和刷新在前端 preventDefault。
            let _win = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("SSH Tool")
                .inner_size(1100.0, 720.0)
                .min_inner_size(760.0, 480.0)
                .theme(Some(tauri::utils::Theme::Light))
                .devtools(true) // 开发期保留；发布构建自动失效
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::term_spawn,
            pty::term_write,
            pty::term_resize,
            pty::term_close,
            pty::term_is_alive,
            pty::default_shell,
            pty::ssh_session,
            config::servers_list,
            config::servers_save,
            config::browse_local,
            config::browse_remote,
            config::local_mkdir,
            config::remote_mkdir,
            config::remote_places,
            config::local_home,
            config::local_places,
            config::installed_fonts,
            transfer::transfer,
            transfer::transfer_cancel
        ])
        .run(tauri::generate_context!())
        .expect("运行 SSH Tool 失败");
}
