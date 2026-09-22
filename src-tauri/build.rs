use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=src/services/qemu_loader.py");
    println!("cargo:rerun-if-env-changed=RDC_AUTH_EXECUTION_RELEASE_URL");
    println!("cargo:rerun-if-env-changed=RDC_AUTH_PUBLIC_KEYS");

    let template = include_str!("src/services/qemu_loader.py");
    let rendered = match (
        env::var("RDC_AUTH_EXECUTION_RELEASE_URL"),
        env::var("RDC_AUTH_PUBLIC_KEYS"),
    ) {
        (Ok(release_url), Ok(public_keys))
            if !release_url.trim().is_empty() && !public_keys.trim().is_empty() =>
        {
            template
                .replace("__RDC_EXECUTION_RELEASE_URL__", release_url.trim())
                .replace("__RDC_AUTH_PUBLIC_KEYS__", public_keys.trim())
        }
        _ => template.to_owned(),
    };
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    fs::write(out_dir.join("qemu_loader.py"), rendered).expect("write rendered qemu loader");

    tauri_build::build()
}
