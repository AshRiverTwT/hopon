fn main() {
    // libwebrtc is built with the static CRT (/MT) and we link Rust with
    // +crt-static (.cargo/config.toml). Tauri's default "static vcruntime,
    // dynamic UCRT" mix would conflict, so turn it off: the whole CRT is then
    // static and the app needs no VC++ redistributable.
    let attrs = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new().static_vc_runtime(false));
    tauri_build::try_build(attrs).expect("tauri build");
}
