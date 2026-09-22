//! Minimal QMP client (std-only, newline-delimited JSON over loopback TCP).
//!
//! QMP is not a convenience here, it is the *only* channel through which a
//! running VM's block layer may be written to. [`crate::vm::snapshot_plan`]
//! decides between this module and `qemu-img`; `qemu-img` must never touch a
//! disk a live QEMU has open (Bug A).
//!
//! The pure half of the protocol — frames, reply parsing, the plan/invariant
//! functions — lives in [`crate::vm`] and is unit-tested there. This module is
//! the runtime glue: connect, greet, negotiate, send one command, read its
//! reply, and classify failures into *transport* vs *rejected* so callers can
//! tell "we could not ask" (untestable) from "QEMU said no" (a real failure).

use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::time::Duration;

use crate::vm;

/// Default budget for the liveness probe (loopback: answers are immediate).
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(750);
/// Default budget for a real QMP command such as an internal snapshot.
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

/// A QMP failure, split by whether the channel worked at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QmpError {
    /// Could not talk to QMP (connect/read/write/protocol). The VM state is
    /// unknown, so a caller must not conclude "safe to use qemu-img".
    Transport(String),
    /// QMP answered with an `error` member: the command itself was refused.
    Rejected(String),
}

impl std::fmt::Display for QmpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            QmpError::Transport(e) => write!(f, "qmp transport: {e}"),
            QmpError::Rejected(e) => write!(f, "qmp rejected: {e}"),
        }
    }
}

impl QmpError {
    /// One-line rendering for reports.
    pub fn message(&self) -> &str {
        match self {
            QmpError::Transport(e) | QmpError::Rejected(e) => e,
        }
    }
}

/// Probe `127.0.0.1:<port>` for a live QEMU: connect, then demand the QMP
/// greeting. Anything else (refused, timeout, foreign listener) is classified
/// without ever claiming the VM is stopped.
pub fn probe(port: u16, timeout: Duration) -> vm::QmpProbe {
    let Some(addr) = loopback(port) else {
        return vm::QmpProbe::TimedOut;
    };
    let stream = match connect_bounded(addr, timeout) {
        ConnectOutcome::Connected(s) => s,
        ConnectOutcome::Refused => return vm::QmpProbe::Refused,
        ConnectOutcome::Timeout | ConnectOutcome::Failed(_) => return vm::QmpProbe::TimedOut,
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let mut line = String::new();
    let greeted = BufReader::new(stream)
        .read_line(&mut line)
        .map(|n| n > 0 && vm::qmp_greeting_received(&line))
        .unwrap_or(false);
    if greeted {
        vm::QmpProbe::Answered
    } else {
        // Something is listening but it is not QEMU's QMP: liveness unknown.
        vm::QmpProbe::TimedOut
    }
}

/// Outcome of a bounded blocking connect.
enum ConnectOutcome {
    Connected(TcpStream),
    /// Nothing is listening — the VM is stopped.
    Refused,
    /// No answer inside the budget — liveness unknown.
    Timeout,
    Failed(String),
}

/// Blocking `connect` on a worker thread, so a filtered/black-holed port cannot
/// hang the caller.
///
/// Deliberately *not* `TcpStream::connect_timeout`: on Windows that reports
/// `TimedOut` for a refused connection too (measured), which would make a
/// stopped VM indistinguishable from an unknown one — and "unknown" makes every
/// caller refuse to touch the disk, so the distinction has to come from a real
/// connect. The budget only bounds the *caller*: a worker still blocked in
/// `connect` (only possible for a filtered port; loopback makes this
/// pathological) is left to finish on its own.
fn connect_bounded(addr: SocketAddr, budget: Duration) -> ConnectOutcome {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(TcpStream::connect(addr));
    });
    match rx.recv_timeout(budget) {
        Ok(Ok(s)) => ConnectOutcome::Connected(s),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => ConnectOutcome::Refused,
        Ok(Err(e)) => ConnectOutcome::Failed(e.to_string()),
        Err(_) => ConnectOutcome::Timeout,
    }
}

fn loopback(port: u16) -> Option<SocketAddr> {
    (std::net::Ipv4Addr::LOCALHOST, port)
        .to_socket_addrs()
        .ok()?
        .next()
}

/// A connected, capability-negotiated QMP channel.
pub struct Client {
    reader: BufReader<TcpStream>,
    writer: TcpStream,
}

impl Client {
    /// Connect, read the greeting, negotiate `qmp_capabilities`.
    pub fn connect(port: u16, timeout: Duration) -> Result<Self, QmpError> {
        let addr = loopback(port)
            .ok_or_else(|| QmpError::Transport(format!("cannot resolve 127.0.0.1:{port}")))?;
        let stream = match connect_bounded(addr, timeout) {
            ConnectOutcome::Connected(s) => s,
            ConnectOutcome::Refused => {
                return Err(QmpError::Transport(format!(
                    "connect 127.0.0.1:{port}: connection refused (is the VM running?)"
                )))
            }
            ConnectOutcome::Timeout => {
                return Err(QmpError::Transport(format!(
                    "connect 127.0.0.1:{port}: no answer within {timeout:?}"
                )))
            }
            ConnectOutcome::Failed(e) => {
                return Err(QmpError::Transport(format!(
                    "connect 127.0.0.1:{port}: {e}"
                )))
            }
        };
        stream
            .set_read_timeout(Some(timeout))
            .and_then(|_| stream.set_write_timeout(Some(timeout)))
            .map_err(|e| QmpError::Transport(e.to_string()))?;
        let reader = BufReader::new(
            stream
                .try_clone()
                .map_err(|e| QmpError::Transport(e.to_string()))?,
        );
        let mut client = Self {
            reader,
            writer: stream,
        };
        let greeting = client
            .read_line()
            .map_err(|e| QmpError::Transport(format!("read greeting: {e}")))?;
        if !vm::qmp_greeting_received(&greeting) {
            return Err(QmpError::Transport(format!(
                "no QMP greeting — endpoint is not a QEMU QMP socket (got {:?})",
                greeting.trim()
            )));
        }
        client.command(vm::qmp_capabilities_frame())?;
        Ok(client)
    }

    /// Send one command and return its (successful) reply line.
    pub fn command(&mut self, frame: &str) -> Result<String, QmpError> {
        writeln!(self.writer, "{frame}")
            .and_then(|_| self.writer.flush())
            .map_err(|e| QmpError::Transport(format!("write: {e}")))?;
        loop {
            let line = self
                .read_line()
                .map_err(|e| QmpError::Transport(format!("read reply: {e}")))?;
            if let Some(desc) = vm::qmp_reply_error(&line) {
                return Err(QmpError::Rejected(desc));
            }
            if vm::qmp_reply_is_ok(&line) {
                return Ok(line);
            }
            // Asynchronous events ({"event": ...}) can arrive at any time and
            // are not the reply we are waiting for.
            if !line.contains("\"event\"") {
                return Err(QmpError::Transport(format!(
                    "unexpected QMP frame: {}",
                    line.trim()
                )));
            }
        }
    }

    fn read_line(&mut self) -> Result<String, String> {
        let mut line = String::new();
        let n = self
            .reader
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("connection closed by QEMU".into());
        }
        Ok(line)
    }
}

/// The block device of a running VM whose active image is `disk`: ask QMP
/// (`query-block`) and fall back to the argv convention ([`vm::DISK_DEVICE_ID`])
/// when the reply cannot be matched (e.g. a VM started before `id=disk0`).
pub fn device_for_disk(port: u16, disk: &Path, timeout: Duration) -> Result<String, QmpError> {
    let mut client = Client::connect(port, timeout)?;
    let reply = client.command(vm::qmp_query_block_frame())?;
    Ok(vm::qmp_device_for_disk(&reply, disk).unwrap_or_else(|| vm::DISK_DEVICE_ID.to_string()))
}

/// Take an internal snapshot on a running VM.
pub fn internal_snapshot(
    port: u16,
    device: &str,
    tag: &str,
    timeout: Duration,
) -> Result<(), QmpError> {
    let mut client = Client::connect(port, timeout)?;
    client.command(&vm::qmp_internal_snapshot_frame(device, tag))?;
    Ok(())
}

/// Delete an internal snapshot of a running VM (keeps `verify`'s timing probe
/// from accumulating snapshot table entries).
pub fn delete_internal_snapshot(
    port: u16,
    device: &str,
    tag: &str,
    timeout: Duration,
) -> Result<(), QmpError> {
    let mut client = Client::connect(port, timeout)?;
    client.command(&vm::qmp_delete_internal_snapshot_frame(device, tag))?;
    Ok(())
}

/// Reclaim guest pages through the virtio-balloon device and return QEMU's
/// verified post-request `actual` byte count. A missing/non-positive value is
/// treated as unverifiable rather than reported as success.
pub fn reclaim_memory(port: u16, target_mib: u32, timeout: Duration) -> Result<u64, QmpError> {
    let target_bytes = u64::from(target_mib)
        .checked_mul(1024 * 1024)
        .ok_or_else(|| QmpError::Transport("balloon target overflows byte count".into()))?;
    let mut client = Client::connect(port, timeout)?;
    client.command(&vm::qmp_balloon_frame(target_bytes))?;
    let reply = client.command(vm::qmp_query_balloon_frame())?;
    let actual = serde_json::from_str::<serde_json::Value>(reply.trim())
        .ok()
        .and_then(|value| value.pointer("/return/actual")?.as_u64())
        .filter(|actual| *actual > 0)
        .ok_or_else(|| {
            QmpError::Transport("query-balloon reply has no positive actual byte count".into())
        })?;
    Ok(actual)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic half of the closed-port coverage: the mapping from probe
    /// class to liveness to snapshot plan, asserted directly. No socket is
    /// involved, so this is what pins Bug A's invariants even on a machine
    /// whose loopback behaves unusually (see `probe_of_a_dead_port_is_never_alive`).
    #[test]
    fn probe_classes_map_to_liveness_and_snapshot_plan() {
        // Refused is the *only* class that proves the VM is stopped, and the
        // only one that licenses qemu-img.
        let stopped = vm::vm_liveness_from_qmp_probe(vm::QmpProbe::Refused);
        assert_eq!(stopped, vm::VmLiveness::Stopped);
        assert_eq!(vm::snapshot_plan(stopped, true), vm::SnapshotPlan::QemuImg);

        // A QMP greeting proves a live QEMU owns the image: QMP only.
        let running = vm::vm_liveness_from_qmp_probe(vm::QmpProbe::Answered);
        assert_eq!(running, vm::VmLiveness::Running);
        assert_eq!(
            vm::snapshot_plan(running, true),
            vm::SnapshotPlan::QmpInternal
        );
        // Running with an unusable QMP channel skips; it must not fall back.
        assert!(matches!(
            vm::snapshot_plan(running, false),
            vm::SnapshotPlan::Skip(_)
        ));

        // An unanswered probe proves nothing: unknown liveness, either way.
        let unknown = vm::vm_liveness_from_qmp_probe(vm::QmpProbe::TimedOut);
        assert_eq!(unknown, vm::VmLiveness::Unknown);
        for qmp_usable in [true, false] {
            assert!(
                matches!(
                    vm::snapshot_plan(unknown, qmp_usable),
                    vm::SnapshotPlan::Skip(_)
                ),
                "unknown liveness must never license a write plan"
            );
        }
    }

    /// Socket half: probe a port that was just released. What the local stack
    /// reports here is *not* portable — normally the connect gets a RST
    /// (`Refused`), but a local proxy or firewall can swallow that RST so the
    /// same connect reports nothing at all (`TimedOut`; observed on Windows 11
    /// with v2rayN running). Both mean "nobody is serving", so this test asserts
    /// the environment-independent safety property instead of the exact class:
    /// a dead port is never alive, and it never yields a plan that writes with
    /// qemu-img unless the connect positively proved the port is closed.
    #[test]
    fn probe_of_a_dead_port_is_never_alive() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);
        let p = probe(port, Duration::from_millis(750));
        assert_ne!(
            p,
            vm::QmpProbe::Answered,
            "a dead port must never read as alive"
        );
        let liveness = vm::vm_liveness_from_qmp_probe(p);
        assert_ne!(liveness, vm::VmLiveness::Running);
        match p {
            // The textbook outcome: RST received, the VM is provably stopped.
            vm::QmpProbe::Refused => {
                assert_eq!(liveness, vm::VmLiveness::Stopped);
                assert_eq!(vm::snapshot_plan(liveness, true), vm::SnapshotPlan::QemuImg);
            }
            // The swallowed-RST outcome: nothing answered, so nothing is proven
            // and qemu-img stays out of the picture.
            vm::QmpProbe::TimedOut => {
                assert_eq!(liveness, vm::VmLiveness::Unknown);
                assert!(matches!(
                    vm::snapshot_plan(liveness, true),
                    vm::SnapshotPlan::Skip(_)
                ));
            }
            vm::QmpProbe::Answered => unreachable!("asserted above"),
        }
    }

    #[test]
    fn probe_refuses_to_guess_from_a_foreign_listener() {
        // A listener that does not speak QMP must classify as unknown, not as
        // "a VM is running" (and never as "stopped" either).
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let _ = s.write_all(b"not qmp at all\n");
            }
        });
        assert_eq!(
            probe(port, Duration::from_millis(500)),
            vm::QmpProbe::TimedOut
        );
        assert_eq!(
            vm::snapshot_plan(vm::vm_liveness_from_qmp_probe(vm::QmpProbe::TimedOut), true),
            vm::SnapshotPlan::Skip(
                "could not prove the disk is idle (no QMP answer): refusing to write \
                 to a possibly live disk with qemu-img"
            )
        );
    }

    #[test]
    fn connect_to_a_dead_endpoint_is_a_transport_error() {
        // Same environment caveat as `probe_of_a_dead_port_is_never_alive`:
        // depending on whether the loopback RST survives the local network stack,
        // the connect fails as "refused" or as "no answer within <budget>". Both
        // are transport failures; what matters is that a dead endpoint never
        // yields a client and never a `Rejected` (which would mean QMP answered).
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);
        match Client::connect(port, Duration::from_millis(750)) {
            Ok(_) => panic!("nothing should be listening on a just-released port"),
            Err(e) => {
                assert!(matches!(e, QmpError::Transport(_)), "{e:?}");
                let message = e.message();
                assert!(
                    message.contains("refused") || message.contains("no answer within"),
                    "a dead endpoint must report that nobody served it: {e:?}"
                );
            }
        }
    }

    #[test]
    fn a_qmp_error_reply_is_reported_as_rejected() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        std::thread::spawn(move || {
            let Ok((stream, _)) = listener.accept() else {
                return;
            };
            let mut reader = BufReader::new(stream.try_clone().expect("clone"));
            let mut writer = stream;
            let _ = writer.write_all(b"{\"QMP\": {\"version\": {}}}\n");
            let mut line = String::new();
            let _ = reader.read_line(&mut line); // qmp_capabilities
            let _ = writer.write_all(b"{\"return\": {}}\n");
            let _ = reader.read_line(&mut line); // the real command
            let _ = writer.write_all(
                b"{\"error\": {\"class\": \"GenericError\", \"desc\": \"internal snapshots not supported\"}}\n",
            );
        });
        let mut client = Client::connect(port, Duration::from_secs(5)).expect("connect");
        let err = client
            .command(&vm::qmp_internal_snapshot_frame("disk0", "verify-1"))
            .expect_err("rejected");
        assert_eq!(
            err,
            QmpError::Rejected("internal snapshots not supported".into())
        );
    }

    #[test]
    fn events_between_replies_are_skipped() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        std::thread::spawn(move || {
            let Ok((stream, _)) = listener.accept() else {
                return;
            };
            let mut reader = BufReader::new(stream.try_clone().expect("clone"));
            let mut writer = stream;
            let _ = writer.write_all(b"{\"QMP\": {\"version\": {}}}\n");
            let mut line = String::new();
            let _ = reader.read_line(&mut line);
            let _ = writer.write_all(b"{\"return\": {}}\n");
            let _ = reader.read_line(&mut line);
            // A RESET event arrives before the command's reply.
            let _ = writer.write_all(b"{\"event\": \"RESET\", \"data\": {\"guest\": false}}\n");
            let _ = writer.write_all(b"{\"return\": {}}\n");
        });
        let mut client = Client::connect(port, Duration::from_secs(5)).expect("connect");
        assert!(client.command(vm::qmp_query_block_frame()).is_ok());
    }

    #[test]
    fn reclaim_memory_sets_target_and_returns_verified_actual_bytes() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            let mut reader = BufReader::new(stream.try_clone().expect("clone"));
            let mut writer = stream;
            writer
                .write_all(b"{\"QMP\":{\"version\":{},\"capabilities\":[]}}\n")
                .expect("greeting");
            let mut line = String::new();
            reader.read_line(&mut line).expect("capabilities");
            writer.write_all(b"{\"return\":{}}\n").expect("cap reply");
            line.clear();
            reader.read_line(&mut line).expect("balloon");
            let balloon: serde_json::Value = serde_json::from_str(line.trim()).expect("json");
            assert_eq!(balloon["execute"], "balloon");
            assert_eq!(balloon["arguments"]["value"], 2 * 1024 * 1024 * 1024u64);
            writer
                .write_all(b"{\"return\":{}}\n")
                .expect("balloon reply");
            line.clear();
            reader.read_line(&mut line).expect("query balloon");
            assert_eq!(line.trim(), vm::qmp_query_balloon_frame());
            writer
                .write_all(b"{\"return\":{\"actual\":2147483648}}\n")
                .expect("query reply");
        });

        assert_eq!(
            reclaim_memory(port, 2048, Duration::from_secs(5)).expect("reclaim"),
            2 * 1024 * 1024 * 1024u64
        );
        server.join().expect("server");
    }

    #[test]
    fn reclaim_memory_rejects_an_unverifiable_balloon_reply() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            let mut reader = BufReader::new(stream.try_clone().expect("clone"));
            let mut writer = stream;
            writer
                .write_all(b"{\"QMP\":{\"version\":{},\"capabilities\":[]}}\n")
                .expect("greeting");
            let mut line = String::new();
            reader.read_line(&mut line).expect("capabilities");
            writer.write_all(b"{\"return\":{}}\n").expect("cap reply");
            line.clear();
            reader.read_line(&mut line).expect("balloon");
            writer
                .write_all(b"{\"return\":{}}\n")
                .expect("balloon reply");
            line.clear();
            reader.read_line(&mut line).expect("query balloon");
            writer
                .write_all(b"{\"return\":{\"actual\":\"unknown\"}}\n")
                .expect("query reply");
        });

        let result = reclaim_memory(port, 2048, Duration::from_secs(5));
        assert!(matches!(result, Err(QmpError::Transport(message)) if message.contains("actual")));
        server.join().expect("server");
    }
}
