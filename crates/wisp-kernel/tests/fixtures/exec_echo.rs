//! An exec-tier plugin for the kernel's tests: JSON-RPC 2.0 over stdio, one message per line, plain
//! blocking IO. Modes (argv[1]): `ok`, `slowinit` (never finishes initialize), `dies` (exits at once).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::needless_pass_by_value,
    clippy::type_complexity,
    clippy::too_many_lines,
    clippy::too_many_arguments,
    clippy::many_single_char_names
)]
use std::io::{BufRead, Write};

use serde_json::{Value, json};

struct Rpc {
    lines: std::io::Lines<std::io::StdinLock<'static>>,
    next: u64,
}

impl Rpc {
    fn send(v: &Value) {
        let mut out = std::io::stdout().lock();
        out.write_all(v.to_string().as_bytes()).unwrap();
        out.write_all(b"\n").unwrap();
        out.flush().unwrap();
    }

    /// Sends a request and waits for its answer, serving the kernel's requests meanwhile.
    fn request(&mut self, method: &str, params: Value) -> Result<Value, Value> {
        self.next += 1;
        let id = self.next;
        Self::send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        loop {
            let m = self.read()?;
            if m.get("method").is_some() {
                self.serve(&m);
            } else if m["id"] == id {
                return m.get("error").map_or_else(|| Ok(m["result"].clone()), |e| Err(e.clone()));
            }
        }
    }

    fn read(&mut self) -> Result<Value, Value> {
        let line = self.lines.next().ok_or(Value::Null)?.map_err(|_| Value::Null)?;
        serde_json::from_str(&line).map_err(|_| Value::Null)
    }

    fn answer(id: &Value, r: Result<Value, Value>) {
        if id.is_null() {
            return;
        }
        match r {
            Ok(v) => Self::send(&json!({ "jsonrpc": "2.0", "id": id, "result": v })),
            Err(e) => Self::send(&json!({ "jsonrpc": "2.0", "id": id, "error": e })),
        }
    }

    fn serve(&mut self, m: &Value) {
        let p = &m["params"];
        let r = match m["method"].as_str().unwrap_or_default() {
            "initialize" => {
                if std::env::args().nth(1).as_deref() == Some("slowinit") {
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(60));
                    }
                }
                for c in ["say", "nested", "deep", "hook", "setting", "crash", "env", "path"] {
                    self.request("command.register", json!({ "id": format!("echo.{c}") })).unwrap();
                }
                self.request("intercept.register", json!({ "n": 0, "hook": "before:go", "failure": "closed" })).unwrap();
                self.request("on", json!({ "n": 0, "type": "host.ping" })).unwrap();
                self.request("contribute", json!({ "point": "host.list", "item": { "id": "echo" } })).unwrap();
                Ok(json!({ "ok": true }))
            }
            "command.run" => self.command(p),
            "intercept.run" => Ok(if p["ctx"]["block"] == true {
                json!({ "kind": "veto", "code": "nope", "message": "echo says no", "then": [] })
            } else {
                json!({ "kind": "modify", "ctx": { "seen": "echo" } })
            }),
            "event" => self.request("run", json!({ "cmd": "host.record", "args": p["e"]["data"] })).map(|_| Value::Null),
            "settings.changed" => Ok(Value::Null),
            other => Err(json!({ "code": -32601, "message": format!("no method {other}") })),
        };
        Self::answer(&m["id"], r);
    }

    fn command(&mut self, p: &Value) -> Result<Value, Value> {
        let call = p["call"].clone();
        match p["id"].as_str().unwrap_or_default() {
            "echo.say" => {
                self.request("emit", json!({ "type": "echo.said", "data": p["args"], "call": call }))?;
                Ok(json!({ "echoed": p["args"] }))
            }
            "echo.nested" => {
                let inner = self.request("run", json!({ "cmd": "host.read", "args": null, "call": call }))?;
                Ok(json!({ "depth": p["trace"]["depth"], "inner": inner }))
            }
            "echo.deep" => self.request("run", json!({ "cmd": "echo.deep", "args": null, "call": call })),
            "echo.hook" => self.request("hook", json!({ "hook": "before:go", "ctx": p["args"], "call": call })),
            "echo.setting" => self.request("settings.get", json!({ "key": "echo.greeting" })),
            "echo.crash" => std::process::exit(3),
            // what its environment holds (names only): an untrusted plugin's is nearly empty (ADR-0048)
            "echo.env" => {
                let mut names: Vec<String> = std::env::vars().map(|(k, _)| k).collect();
                names.sort();
                Ok(json!({ "names": names }))
            }
            // the PATH it started with (ADR-0057: the one wisp finds programs on)
            "echo.path" => Ok(json!({ "path": std::env::var("PATH").ok() })),
            _ => Err(json!({ "code": -32601, "message": "no such command" })),
        }
    }
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("dies") {
        std::process::exit(1);
    }
    let mut rpc = Rpc { lines: std::io::stdin().lock().lines(), next: 0 };
    while let Ok(m) = rpc.read() {
        if m.get("method").is_some() {
            rpc.serve(&m);
        }
    }
}
