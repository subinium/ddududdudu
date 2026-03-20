mod app;
mod ask_user;
mod bridge;
mod hangul;
mod input;
mod protocol;
mod render;
mod theme;

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use slt::{KeyCode, RunConfig};

use crate::app::App;
use crate::bridge::{poll_bridge, send_command, spawn_bridge};
use crate::input::handle_input;
use crate::protocol::BridgeCommand;
use crate::render::render_app;
use crate::theme::ddudu_theme;

fn parse_args() -> Result<(String, String)> {
    let mut node_path = None;
    let mut bridge_path = None;
    let mut args = std::env::args().skip(1);

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--node" => node_path = args.next(),
            "--bridge" => bridge_path = args.next(),
            _ => {}
        }
    }

    let node_path = node_path.context("missing --node")?;
    let bridge_path = bridge_path.context("missing --bridge")?;
    Ok((node_path, bridge_path))
}

fn main() -> Result<()> {
    let (node_path, bridge_path) = parse_args()?;
    let (mut child, mut stdin, receiver) = spawn_bridge(&node_path, &bridge_path)?;
    let mut app = App::new();

    let config = RunConfig::default()
        .tick_rate(Duration::from_millis(33))
        .mouse(true)
        .kitty_keyboard(true)
        .theme(ddudu_theme())
        .max_fps(30)
        .title("ddudu");

    let run_result = slt::run_with(config, |ui| {
        poll_bridge(&receiver, &mut app, ui);

        if ui.key_code(KeyCode::BackTab) {
            let _ = send_command(&mut stdin, BridgeCommand::CycleMode { direction: 1 });
        }

        render_app(ui, &mut app);
        if app.pending_cycle_mode {
            app.pending_cycle_mode = false;
            let _ = send_command(&mut stdin, BridgeCommand::CycleMode { direction: 1 });
        }
        if let Err(error) = handle_input(ui, &mut app, &mut stdin) {
            app.fatal_error = Some(error.to_string());
        }
    });

    let _ = child.kill();
    let _ = child.wait();
    run_result.map_err(|error| anyhow!(error))
}
