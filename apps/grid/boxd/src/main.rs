//! boxd: see lib.rs.
fn main() {
    std::process::exit(wisp_grid_boxd::main_with(std::env::args().skip(1).collect()));
}
