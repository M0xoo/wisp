fn main() {
    // Declaring the commands puts them under the ACL: without a manifest, a capability wouldn't be
    // what decides who may call them. capability.json grants them to wisp's own page only.
    let manifest = tauri_build::AppManifest::new().commands(&["pick_folder", "start_drag", "zoom_window", "notify_show"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)).expect("tauri-build failed");
}
