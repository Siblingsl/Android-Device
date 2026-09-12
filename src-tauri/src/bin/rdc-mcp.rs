use std::env;

fn main() {
    let allow_side_effects = env::args().skip(1).any(|arg| arg == "--allow-side-effects");
    if let Err(error) = redroid_device_center_lib::services::mcp::run_stdio(allow_side_effects) {
        eprintln!("rdc-mcp: {error}");
        std::process::exit(1);
    }
}
