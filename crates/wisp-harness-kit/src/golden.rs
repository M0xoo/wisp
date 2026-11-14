//! Replaying a recorded run against v1's golden (gate G6, for every harness). Plain data in: the
//! fixture's stdout (`<name>.jsonl`, the run's folder as `@CWD@`), its `<name>.meta.json` (exit, run
//! options, `drop`, `stopAfter`) and v1's events (`<name>.v1.json`). The test reads the files; this
//! module only compares, so it stays sans-IO.

use serde_json::Value;

use crate::event::HarnessEvent;
use crate::js;
use crate::parser::{Exit, LineParser, Out, ReplayIo};

/// JSON equality with numbers compared as numbers (v1's 5 and our 5.0 are the same).
pub fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

fn drop_path(v: &mut Value, path: &[&str]) {
    match path {
        [] => {}
        [last] => {
            if let Some(o) = v.as_object_mut() {
                o.remove(*last);
            }
        }
        [head, rest @ ..] => {
            if let Some(next) = v.get_mut(*head) {
                drop_path(next, rest);
            }
        }
    }
}

/// The exit the fixture's process had; one with `stopAfter` was stopped by the user (only those: the
/// replay that made the golden exited on its own, whatever signal the recording ended with).
pub fn exit_of(meta: &Value) -> Exit {
    let e = &meta["exit"];
    let stopped = meta.get("stopAfter").is_some();
    Exit {
        code: e["code"].as_i64().and_then(|c| i32::try_from(c).ok()),
        signal: e["signal"].as_str().map(str::to_owned),
        stderr: js::trim(e["stderr"].as_str().unwrap_or("")).to_owned(),
        stopped,
        stop_requested: stopped,
    }
}

/// Replays `stdout` (with `@CWD@` as `cwd`) through `parser` and compares with `v1`. Err: where they part.
pub fn check<P: LineParser + ?Sized>(
    parser: &mut P,
    cwd: &str,
    meta: &Value,
    stdout: &str,
    v1: &str,
    io: &mut dyn ReplayIo,
) -> Result<(), String> {
    let stdout = stdout.replace("@CWD@", cwd);
    let lines: Vec<&str> = stdout.lines().collect();
    let mut events = Vec::new();
    let mut outs = Vec::new();
    let mut take = |outs: &mut Vec<Out>, events: &mut Vec<HarnessEvent>| {
        for o in outs.drain(..) {
            match o {
                Out::Event(e) => events.push(e),
                Out::Io(step) => io.run(&step, events),
                Out::Stop => {}
            }
        }
    };
    let at = |i: usize| i64::try_from(i).unwrap_or(0);
    for (i, line) in lines.iter().enumerate() {
        parser.line(line, at(i), &mut outs);
        take(&mut outs, &mut events);
    }
    // v1's replay wrote the recorded stderr before the exit (opencode reports refusals there)
    let stderr = meta["exit"]["stderr"].as_str().unwrap_or("");
    if !stderr.is_empty() {
        parser.stderr(stderr, at(lines.len()), &mut outs);
        take(&mut outs, &mut events);
    }
    parser.close(&exit_of(meta), at(lines.len()), &mut outs);
    take(&mut outs, &mut events);
    let text = serde_json::to_string(&events.iter().map(HarnessEvent::to_json).collect::<Vec<_>>())
        .map_err(|e| e.to_string())?
        .replace(cwd, "@CWD@");
    let mut got: Vec<Value> = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let drops: Vec<&str> = meta["drop"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    for e in &mut got {
        for d in &drops {
            drop_path(e, &d.split('.').collect::<Vec<_>>());
        }
    }
    let want: Vec<Value> = serde_json::from_str(v1).map_err(|e| e.to_string())?;
    if got.len() == want.len() && got.iter().zip(&want).all(|(a, b)| same(a, b)) {
        return Ok(());
    }
    let at = got.iter().zip(&want).position(|(a, b)| !same(a, b)).unwrap_or(got.len().min(want.len()));
    let show = |v: Option<&Value>| v.map_or_else(|| "-".into(), Value::to_string);
    Err(format!(
        "{} events, v1 had {}; first difference at #{at}:\n  got  {}\n  want {}",
        got.len(),
        want.len(),
        show(got.get(at)),
        show(want.get(at))
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_compare_as_numbers() {
        assert!(same(&json!({ "a": 5 }), &json!({ "a": 5.0 })));
        assert!(!same(&json!([1]), &json!([1, 2])));
        let e = exit_of(&json!({ "exit": { "code": null, "signal": "SIGTERM", "stderr": " x \n" }, "stopAfter": 2 }));
        assert!(e.stopped && e.stop_requested && e.stderr == "x");
        assert!(!exit_of(&json!({ "exit": { "code": null, "signal": "SIGTERM", "stderr": "" } })).stopped);
    }
}
