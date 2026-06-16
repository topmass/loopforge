// LoopForge Tauri shell. The native window's only job beyond hosting the React
// frontend is to manage the LoopForge server lifecycle: spawn it on launch
// (pointed at the chosen project folder on a free port), expose that port to
// the frontend, and stop it on quit. The frontend is identical to the
// browser-served build - it just talks to the localhost API.
//
// NOTE: building this requires the Tauri Linux webview deps (webkit2gtk-4.1,
// gtk3) which must be installed on the build machine. The browser-served GUI
// (`loopforge gui`) is the verified path until then.

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{Manager, State};

struct ServerHandle(Mutex<Option<Child>>);

#[tauri::command]
fn start_server(root: String, port: u16, app: tauri::AppHandle, state: State<ServerHandle>) -> Result<u16, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(port);
    }
    // Resolve the bundled launcher + Deno source shipped as Tauri resources.
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource dir: {e}"))?;
    let launcher = resource_dir.join("loopforge-launcher");
    let child = Command::new(&launcher)
        .arg("-C")
        .arg(&root)
        .arg("serve")
        .arg("--port")
        .arg(port.to_string())
        .spawn()
        .map_err(|e| format!("failed to start LoopForge server: {e}"))?;
    *guard = Some(child);
    Ok(port)
}

#[tauri::command]
fn stop_server(state: State<ServerHandle>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ServerHandle(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![start_server, stop_server])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<ServerHandle>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running LoopForge");
}
