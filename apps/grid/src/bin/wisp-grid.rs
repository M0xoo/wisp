//! `wisp-grid serve|init|dev|doctor|…`: the edge, the control plane and the CLI (cli.rs).
#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(wisp_grid::cli::main(args).await);
}
