fn main() {
    // `tauri.conf.json` 的 `version` 指向 `../package.json`，而 tauri-build 只监听
    // 配置文件本身。不补这一行，增量构建改了版本号也可能沿用旧的版本资源。
    println!("cargo:rerun-if-changed=../package.json");
    tauri_build::build()
}
