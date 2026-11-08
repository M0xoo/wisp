//! `${{ … }}` expressions (ADR-0028): paths into earlier steps' results (`tasks.tests.output.failed`,
//! `tasks.tests.state`), `inputs.x` and `matrix.agent`; literals (numbers, `'text'`, `true`, `false`,
//! `null`); `== != > < >= <=`, `&& || !` and parentheses. Truthy like JavaScript, so a condition reads
//! the way a CI file's does.

use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Str(String),
    Ident(String),
    Op(&'static str),
    LParen,
    RParen,
}

#[allow(clippy::many_single_char_names)]
fn lex(s: &str) -> Result<Vec<Tok>, String> {
    let mut out = Vec::new();
    let b: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_whitespace() {
            i += 1;
        } else if c == '(' {
            out.push(Tok::LParen);
            i += 1;
        } else if c == ')' {
            out.push(Tok::RParen);
            i += 1;
        } else if c == '\'' || c == '"' {
            let q = c;
            let mut t = String::new();
            i += 1;
            while i < b.len() && b[i] != q {
                t.push(b[i]);
                i += 1;
            }
            if i >= b.len() {
                return Err(format!("an unclosed quote in {s:?}"));
            }
            i += 1;
            out.push(Tok::Str(t));
        } else if c.is_ascii_digit() || (c == '-' && b.get(i + 1).is_some_and(char::is_ascii_digit) && !matches!(out.last(), Some(Tok::Num(_) | Tok::Ident(_) | Tok::Str(_) | Tok::RParen))) {
            let st = i;
            i += 1;
            while i < b.len() && (b[i].is_ascii_digit() || b[i] == '.') {
                i += 1;
            }
            let t: String = b[st..i].iter().collect();
            out.push(Tok::Num(t.parse().map_err(|_| format!("{t:?} isn't a number"))?));
        } else if c.is_alphanumeric() || c == '_' {
            let st = i;
            while i < b.len() && (b[i].is_alphanumeric() || "_.-[]".contains(b[i])) {
                i += 1;
            }
            out.push(Tok::Ident(b[st..i].iter().collect()));
        } else {
            let two: String = b[i..(i + 2).min(b.len())].iter().collect();
            let op = ["==", "!=", ">=", "<=", "&&", "||"].into_iter().find(|o| *o == two);
            if let Some(o) = op {
                out.push(Tok::Op(o));
                i += 2;
            } else if let Some(o) = [">", "<", "!"].into_iter().find(|o| o.starts_with(c)) {
                out.push(Tok::Op(o));
                i += 1;
            } else {
                return Err(format!("{c:?} isn't part of an expression"));
            }
        }
    }
    Ok(out)
}

/// What paths read from: `tasks`, `inputs`, `matrix`.
pub type Scope = Value;

fn path(scope: &Scope, p: &str) -> Value {
    let mut cur = scope;
    for part in p.split('.') {
        let next = match cur {
            Value::Object(o) => o.get(part),
            Value::Array(a) => part.parse::<usize>().ok().and_then(|i| a.get(i)),
            _ => None,
        };
        match next {
            Some(n) => cur = n,
            None => return Value::Null,
        }
    }
    cur.clone()
}

pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

struct Parser<'a> {
    t: &'a [Tok],
    i: usize,
    scope: &'a Scope,
}

impl Parser<'_> {
    fn peek(&self) -> Option<&Tok> {
        self.t.get(self.i)
    }
    fn or(&mut self) -> Result<Value, String> {
        let mut l = self.and()?;
        while self.peek() == Some(&Tok::Op("||")) {
            self.i += 1;
            let r = self.and()?;
            l = if truthy(&l) { l } else { r };
        }
        Ok(l)
    }
    fn and(&mut self) -> Result<Value, String> {
        let mut l = self.cmp()?;
        while self.peek() == Some(&Tok::Op("&&")) {
            self.i += 1;
            let r = self.cmp()?;
            l = if truthy(&l) { r } else { l };
        }
        Ok(l)
    }
    fn cmp(&mut self) -> Result<Value, String> {
        let l = self.unary()?;
        let Some(Tok::Op(op)) = self.peek().cloned() else { return Ok(l) };
        if !["==", "!=", ">", "<", ">=", "<="].contains(&op) {
            return Ok(l);
        }
        self.i += 1;
        let r = self.unary()?;
        let eq = l == r || (num(&l).is_some() && num(&l) == num(&r) && !l.is_string() && !r.is_string()) || (l.is_number() && r.is_string() && num(&r) == num(&l)) || (r.is_number() && l.is_string() && num(&l) == num(&r));
        Ok(json!(match op {
            "==" => eq,
            "!=" => !eq,
            _ => match (num(&l), num(&r)) {
                (Some(a), Some(b)) => match op {
                    ">" => a > b,
                    "<" => a < b,
                    ">=" => a >= b,
                    _ => a <= b,
                },
                _ => false,
            },
        }))
    }
    fn unary(&mut self) -> Result<Value, String> {
        if self.peek() == Some(&Tok::Op("!")) {
            self.i += 1;
            return Ok(json!(!truthy(&self.unary()?)));
        }
        self.atom()
    }
    fn atom(&mut self) -> Result<Value, String> {
        let t = self.peek().cloned().ok_or("an expression ends too soon")?;
        self.i += 1;
        Ok(match t {
            Tok::Num(n) => json!(n),
            Tok::Str(s) => json!(s),
            Tok::Ident(id) => match id.as_str() {
                "true" => json!(true),
                "false" => json!(false),
                "null" => Value::Null,
                _ => path(self.scope, &id),
            },
            Tok::LParen => {
                let v = self.or()?;
                if self.peek() != Some(&Tok::RParen) {
                    return Err("a ( without its )".into());
                }
                self.i += 1;
                v
            }
            Tok::RParen | Tok::Op(_) => return Err(format!("unexpected {t:?}")),
        })
    }
}

/// The value of an expression (with or without its `${{ }}`).
pub fn eval(expr: &str, scope: &Scope) -> Result<Value, String> {
    let e = expr.trim();
    let e = e.strip_prefix("${{").and_then(|x| x.strip_suffix("}}")).unwrap_or(e);
    let toks = lex(e)?;
    let mut p = Parser { t: &toks, i: 0, scope };
    let v = p.or()?;
    if p.i != toks.len() {
        return Err(format!("{e:?}: something after the expression"));
    }
    Ok(v)
}

/// The paths an expression reads (`tasks.tests.output.failed`), to check what it names.
pub fn paths(expr: &str) -> Vec<String> {
    let e = expr.trim();
    let e = e.strip_prefix("${{").and_then(|x| x.strip_suffix("}}")).unwrap_or(e);
    lex(e).unwrap_or_default().into_iter().filter_map(|t| if let Tok::Ident(s) = t { (!["true", "false", "null"].contains(&s.as_str())).then_some(s) } else { None }).collect()
}

/// Every `${{ … }}` in `text` replaced by its value (text as it is; anything else as JSON).
pub fn interpolate(text: &str, scope: &Scope) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = text;
    while let Some(a) = rest.find("${{") {
        out.push_str(&rest[..a]);
        let after = &rest[a + 3..];
        let b = after.find("}}").ok_or_else(|| format!("a ${{{{ without its }}}} in {text:?}"))?;
        match eval(&after[..b], scope)? {
            Value::String(s) => out.push_str(&s),
            Value::Null => {}
            other => out.push_str(&other.to_string()),
        }
        rest = &after[b + 2..];
    }
    out.push_str(rest);
    Ok(out)
}

/// The `${{ }}` expressions in a text.
pub fn exprs(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(a) = rest.find("${{") {
        let after = &rest[a + 3..];
        let Some(b) = after.find("}}") else { break };
        out.push(after[..b].to_owned());
        rest = &after[b + 2..];
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn conditions_read_like_a_ci_file() {
        let s = json!({ "tasks": { "tests": { "state": "done", "output": { "failed": 2, "failures": ["a", "b"], "status": "done" } } }, "inputs": { "v": "2.1" }, "matrix": { "agent": "codex" } });
        let t = |e: &str| eval(e, &s).unwrap();
        assert_eq!(t("${{ tasks.tests.output.failed > 0 }}"), json!(true));
        assert_eq!(t("tasks.tests.output.failed == 2 && tasks.tests.state == 'done'"), json!(true));
        assert_eq!(t("!(tasks.tests.output.failed >= 3) || false"), json!(true));
        assert_eq!(t("tasks.nope.output.x"), Value::Null);
        assert_eq!(t("inputs.v == '2.1'"), json!(true));
        assert_eq!(t("tasks.tests.output.failures.1"), json!("b"));
        assert_eq!(interpolate("Fix ${{ tasks.tests.output.failures }} on ${{ matrix.agent }} for v${{ inputs.v }}", &s).unwrap(), "Fix [\"a\",\"b\"] on codex for v2.1");
        assert!(eval("tasks.x >", &s).is_err());
        assert_eq!(paths("${{ tasks.tests.output.failed > 0 && inputs.v }}"), ["tasks.tests.output.failed", "inputs.v"]);
    }
}
