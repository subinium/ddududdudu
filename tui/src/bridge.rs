use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;

use crate::app::App;
use crate::protocol::{BridgeCommand, BridgeEvent};

pub(crate) const MAX_BRIDGE_EVENTS_PER_FRAME: usize = 256;
pub(crate) const BRIDGE_EVENT_PREFIX: &str = "__DDUDU_BRIDGE__ ";

pub(crate) fn spawn_bridge(
    node_path: &str,
    bridge_path: &str,
) -> Result<(Child, ChildStdin, Receiver<Result<BridgeEvent>>)> {
    let mut child = Command::new(node_path)
        .arg(bridge_path)
        .arg("bridge")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .with_context(|| format!("failed to start bridge: {bridge_path}"))?;

    let stdin = child.stdin.take().context("bridge stdin unavailable")?;
    let stdout = child.stdout.take().context("bridge stdout unavailable")?;
    let (tx, rx) = mpsc::channel::<Result<BridgeEvent>>();

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let outcome = match line {
                Ok(raw) => {
                    let trimmed = raw.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let payload = if let Some(rest) = trimmed.strip_prefix(BRIDGE_EVENT_PREFIX) {
                        rest
                    } else if trimmed.starts_with('{') {
                        trimmed
                    } else {
                        continue;
                    };

                    (|| -> Result<BridgeEvent> {
                        let decoded = if payload.starts_with('{') {
                            payload.to_string()
                        } else {
                            let bytes = BASE64_STANDARD.decode(payload).map_err(|error| {
                                anyhow!("failed to decode bridge event: {error}")
                            })?;
                            String::from_utf8(bytes).map_err(|error| {
                                anyhow!("failed to decode bridge event utf8: {error}")
                            })?
                        };

                        serde_json::from_str::<BridgeEvent>(&decoded)
                            .map_err(|error| anyhow!("failed to parse bridge event: {error}"))
                    })()
                }
                Err(error) => Err(anyhow!("failed to read bridge event: {error}")),
            };

            if tx.send(outcome).is_err() {
                return;
            }
        }

        let _ = tx.send(Err(anyhow!("bridge process closed stdout")));
    });

    Ok((child, stdin, rx))
}

pub(crate) fn send_command(stdin: &mut ChildStdin, command: BridgeCommand) -> Result<()> {
    let raw = serde_json::to_string(&command)?;
    writeln!(stdin, "{raw}")?;
    stdin.flush()?;
    Ok(())
}

pub(crate) fn poll_bridge(
    receiver: &Receiver<Result<BridgeEvent>>,
    app: &mut App,
    ui: &mut slt::Context,
) {
    for _ in 0..MAX_BRIDGE_EVENTS_PER_FRAME {
        match receiver.try_recv() {
            Ok(Ok(ev)) => app.on_bridge_event(ev, ui.tick()),
            Ok(Err(error)) => {
                app.fatal_error = Some(error.to_string());
                break;
            }
            Err(_) => break,
        }
    }
}
