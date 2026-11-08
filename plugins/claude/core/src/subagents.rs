//! The subagent tally of one Claude Code process (edge case 3). Each Agent (or Task) call, or
//! task_started, gives its subagent_type; messages carrying its id as parent_tool_use_id give their
//! model and what they read. Their output_tokens are a snapshot from the stream's start, so a model's
//! output comes from modelUsage: what that model wrote minus the main thread's share, split among the
//! subagents on it by their messages' counts. An Agent result with its own usage wins. A web-fetch
//! agent on a run whose init had no WebFetch is marked `instead: 'WebFetch'`.

use serde_json::{Value, json};
use wisp_harness_kit::Re;
use wisp_harness_kit::js::{json_num, truthy};

use crate::line::ToolUseResult;
use crate::msg::Msg;
use crate::usage::{ModelTokens, n0};

#[derive(Debug, Clone, Copy, Default)]
struct Usage {
    read: f64,
    output: f64,
}

fn usage_of(u: &Value) -> Usage {
    Usage {
        read: n0(&u["input_tokens"])
            + n0(&u["cache_read_input_tokens"])
            + n0(&u["cache_creation_input_tokens"]),
        output: n0(&u["output_tokens"]),
    }
}

#[derive(Debug)]
struct Call {
    id: String,
    kind: String,
    model: String,
    /// message id → (model, read, output), in arrival order
    msgs: Vec<(String, String, Usage)>,
    total: Option<Usage>,
}

#[derive(Debug)]
struct Part {
    call: usize,
    model: String,
    u: Usage,
    fixed: bool,
}

/// One subagent type's row on the receipt.
#[derive(Debug, Default)]
pub struct Tally {
    calls: Vec<Call>,
    /// init's tools, when it sent them
    tools: Option<Vec<Value>>,
    /// the main thread's model, from its own messages
    main: String,
}

static WEB_FETCH: Re = Re::new(r"(?i)^web[-_ ]?fetch");

fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

impl Tally {
    pub fn init(&mut self, list: &Value) {
        if let Some(a) = list.as_array() {
            self.tools = Some(a.clone());
        }
    }

    pub fn call(&mut self, id: &Value, name: &str, input: &Value) {
        let Some(id) = id.as_str().filter(|s| !s.is_empty()) else {
            return;
        };
        if (name == "Agent" || name == "Task") && !self.calls.iter().any(|c| c.id == id) {
            let kind = if truthy(&input["subagent_type"]) {
                wisp_harness_kit::js::string(&input["subagent_type"])
            } else {
                "general-purpose".into()
            };
            let model = if truthy(&input["model"]) {
                wisp_harness_kit::js::string(&input["model"])
            } else {
                String::new()
            };
            self.calls.push(Call {
                id: id.to_owned(),
                kind,
                model,
                msgs: Vec::new(),
                total: None,
            });
        }
    }

    /// An assistant message: from inside a subagent (parent_tool_use_id), or the main thread's.
    pub fn message(&mut self, parent: &Value, m: &Msg<'_>) {
        if !truthy(parent) {
            if crate::msg::truthy(m.model) {
                self.main = crate::msg::text(m.model).into_owned();
            }
            return;
        }
        let Some(c) = parent
            .as_str()
            .and_then(|p| self.calls.iter_mut().find(|c| c.id == p))
        else {
            return;
        };
        if crate::msg::truthy(m.model) {
            c.model = crate::msg::text(m.model).into_owned();
        }
        let Some(crate::msg::Lenient(usage)) = &m.usage else {
            return;
        };
        let id = if m.id.is_some_and(|r| r.get().starts_with('"')) {
            crate::msg::text(m.id)
        } else {
            std::borrow::Cow::Borrowed("")
        };
        let key = if id.is_empty() {
            format!("#{}", c.msgs.len())
        } else {
            id.into_owned()
        };
        let v = |r| n0(&crate::msg::value(r));
        let u = Usage {
            read: v(usage.input_tokens)
                + v(usage.cache_read_input_tokens)
                + v(usage.cache_creation_input_tokens),
            output: v(usage.output_tokens),
        };
        let model = c.model.clone();
        match c.msgs.iter_mut().find(|(k, _, _)| *k == key) {
            Some(slot) => {
                *slot = (
                    key,
                    model,
                    Usage {
                        read: slot.2.read.max(u.read),
                        output: slot.2.output.max(u.output),
                    },
                )
            }
            None => c.msgs.push((key, model, u)),
        }
    }

    /// The Agent call's result; an older Claude Code put the subagent's usage on tool_use_result.
    pub fn result(&mut self, id: &str, r: Option<&ToolUseResult>) {
        let Some(c) = self.calls.iter_mut().find(|c| c.id == id) else {
            return;
        };
        let Some(r) = r else { return };
        if truthy(&r.resolved_model) && c.model.is_empty() {
            c.model = wisp_harness_kit::js::string(&r.resolved_model);
        }
        if r.usage.is_object() && wisp_harness_kit::js::num(&r.usage["output_tokens"]).is_some() {
            c.total = Some(usage_of(&r.usage));
        }
    }

    /// models: this result's new tokens per model; `main_out`: its usage.output_tokens. Clears the tally.
    pub fn take(&mut self, models: Option<&[ModelTokens]>, main_out: &Value) -> Option<Value> {
        if self.calls.is_empty() {
            return None;
        }
        let mut parts = self.parts();
        // None (modelUsage can't be split): the messages' snapshots aren't output either.
        if models.is_none() {
            for p in parts.iter_mut().filter(|p| !p.fixed) {
                p.u.output = 0.0;
            }
        }
        let main_model = if self.main.is_empty() {
            models
                .and_then(|m| m.first())
                .map(|m| m.model.clone())
                .unwrap_or_default()
        } else {
            self.main.clone()
        };
        share_output(&mut parts, models, &main_model, n0(main_out));
        let no_fetch = self
            .tools
            .as_ref()
            .is_some_and(|t| !t.iter().any(|x| x.as_str() == Some("WebFetch")));
        let rows = self.rows(&parts, no_fetch);
        self.calls.clear();
        Some(rows)
    }

    /// Per call and model: what its messages say.
    fn parts(&self) -> Vec<Part> {
        let mut parts = Vec::new();
        for (i, c) in self.calls.iter().enumerate() {
            if let Some(t) = c.total {
                parts.push(Part {
                    call: i,
                    model: c.model.clone(),
                    u: t,
                    fixed: true,
                });
                continue;
            }
            let mut by: Vec<Part> = Vec::new();
            for (_, model, u) in &c.msgs {
                let model = if model.is_empty() {
                    c.model.clone()
                } else {
                    model.clone()
                };
                match by.iter_mut().find(|p| p.model == model) {
                    Some(p) => {
                        p.u.read += u.read;
                        p.u.output += u.output;
                    }
                    None => by.push(Part {
                        call: i,
                        model,
                        u: *u,
                        fixed: false,
                    }),
                }
            }
            if by.is_empty() {
                by.push(Part {
                    call: i,
                    model: c.model.clone(),
                    u: Usage::default(),
                    fixed: false,
                });
            }
            parts.extend(by);
        }
        parts
    }

    fn rows(&self, parts: &[Part], no_fetch: bool) -> Value {
        struct Row {
            kind: String,
            calls: Vec<usize>,
            models: Vec<(String, f64)>,
            read: f64,
            output: f64,
        }
        let mut rows: Vec<Row> = Vec::new();
        for p in parts {
            let kind = &self.calls[p.call].kind;
            let idx = rows
                .iter()
                .position(|r| &r.kind == kind)
                .unwrap_or_else(|| {
                    rows.push(Row {
                        kind: kind.clone(),
                        calls: Vec::new(),
                        models: Vec::new(),
                        read: 0.0,
                        output: 0.0,
                    });
                    rows.len() - 1
                });
            let r = &mut rows[idx];
            if !r.calls.contains(&p.call) {
                r.calls.push(p.call);
            }
            r.read += p.u.read;
            r.output += p.u.output;
            if !p.model.is_empty() {
                match r.models.iter_mut().find(|(m, _)| *m == p.model) {
                    Some(e) => e.1 += p.u.output + 1.0,
                    None => r.models.push((p.model.clone(), p.u.output + 1.0)),
                }
            }
        }
        let mut out: Vec<(f64, usize, Value)> = rows
            .into_iter()
            .map(|mut r| {
                r.models.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
                let model = r.models.first().map(|m| m.0.clone()).unwrap_or_default();
                let mut row = json!({ "type": r.kind, "calls": r.calls.len(), "read": json_num(r.read), "output": json_num(r.output), "model": model });
                // same: on the main thread's model (the receipt offers Subagents on Haiku).
                if !model.is_empty() && model == self.main {
                    row["same"] = Value::Bool(true);
                }
                if no_fetch && WEB_FETCH.is_match(&r.kind) {
                    row["instead"] = Value::String("WebFetch".into());
                }
                (r.output, r.calls.len(), row)
            })
            .collect();
        out.sort_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.1.cmp(&a.1))
        });
        Value::Array(out.into_iter().map(|(_, _, v)| v).collect())
    }
}

/// A model's output from modelUsage, past what the main thread and fixed totals account for.
fn share_output(
    parts: &mut [Part],
    models: Option<&[ModelTokens]>,
    main_model: &str,
    main_out: f64,
) {
    for m in models.unwrap_or(&[]) {
        let fixed: f64 = parts
            .iter()
            .filter(|p| p.model == m.model && p.fixed)
            .map(|p| p.u.output)
            .sum();
        let on: Vec<usize> = parts
            .iter()
            .enumerate()
            .filter(|(_, p)| p.model == m.model && !p.fixed)
            .map(|(i, _)| i)
            .collect();
        if on.is_empty() {
            continue;
        }
        let pool = m.output - if m.model == main_model { main_out } else { 0.0 } - fixed;
        let seen: f64 = on.iter().map(|&i| parts[i].u.output).sum();
        // v1 `if (!(pool > seen)) continue`: NaN counts as not more
        if pool.partial_cmp(&seen) != Some(std::cmp::Ordering::Greater) {
            continue;
        }
        #[allow(clippy::cast_precision_loss)]
        let n = on.len() as f64;
        for &i in &on {
            parts[i].u.output = if seen > 0.0 {
                js_round(pool * parts[i].u.output / seen)
            } else {
                js_round(pool / n)
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pattern_compiles() {
        assert!(WEB_FETCH.compiles());
    }

    #[test]
    fn subagent_output_is_modelusage_minus_the_main_threads_share() {
        // edge case 3
        let mut t = Tally::default();
        let main: Msg = serde_json::from_str(r#"{"model": "opus"}"#).unwrap_or_default();
        t.message(&Value::Null, &main);
        t.call(&json!("a1"), "Agent", &json!({"subagent_type": "Explore"}));
        let line =
            r#"{"id": "m1", "model": "haiku", "usage": {"input_tokens": 100, "output_tokens": 1}}"#;
        let m: Msg = serde_json::from_str(line).unwrap_or_default();
        t.message(&json!("a1"), &m);
        let models = [
            ModelTokens {
                model: "haiku".into(),
                input: 100.0,
                output: 50.0,
                cache_read: 0.0,
                cache_write: 0.0,
            },
            ModelTokens {
                model: "opus".into(),
                input: 10.0,
                output: 30.0,
                cache_read: 0.0,
                cache_write: 0.0,
            },
        ];
        let rows = t.take(Some(&models), &json!(30));
        assert_eq!(
            rows,
            Some(
                json!([{"type": "Explore", "calls": 1, "read": 100, "output": 50, "model": "haiku"}])
            )
        );
        assert_eq!(t.take(None, &json!(0)), None, "cleared");
    }
}
