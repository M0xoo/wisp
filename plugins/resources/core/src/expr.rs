//! A formula's expressions (ADR-0034): `${…}` in any string. Pure: references and the IO-ish functions
//! (`file`, `env`) go through the caller's [`Scope`]. No general code: references (`agent.reviewer.model`,
//! `var.model`, `local.x`, `each.key`, `count.index`, `module.m.out`), literals, lists, `!`, `==`, `!=`,
//! `&&`, `||`, `c ? a : b`, and a short list of pure functions. `${secret:NAME}` and `${env:NAME}` stay as
//! they are (secrets are read by the server, env by the loader); `$${` is a literal `${`.

use serde_json::{Map, Value};

/// One step of a reference: `.key` or `[0]` / `["key"]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Seg {
    Key(String),
    Index(usize),
}

/// What an expression can see.
pub trait Scope {
    /// The value at `path` (its first segment names a namespace or a kind).
    fn get(&self, path: &[Seg]) -> Result<Value, String>;
    /// `file(path)` and `env(name)`: the functions that read outside the expression.
    fn outside(&self, f: &str, arg: &str) -> Result<Value, String>;
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Id(String),
    Num(f64),
    Str(String),
    Op(&'static str),
}

fn lex(src: &str) -> Result<Vec<Tok>, String> {
    let c: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        if ch.is_whitespace() {
            i += 1;
        } else if ch.is_ascii_alphabetic() || ch == '_' {
            let s = i;
            while i < c.len() && (c[i].is_ascii_alphanumeric() || c[i] == '_' || c[i] == '-') {
                i += 1;
            }
            out.push(Tok::Id(c[s..i].iter().collect()));
        } else if ch.is_ascii_digit() {
            let s = i;
            while i < c.len() && (c[i].is_ascii_digit() || c[i] == '.') {
                i += 1;
            }
            let t: String = c[s..i].iter().collect();
            out.push(Tok::Num(t.parse().map_err(|_| format!("`{t}` isn't a number"))?));
        } else if ch == '"' {
            let mut s = String::new();
            i += 1;
            loop {
                match c.get(i) {
                    None => return Err("a string isn't closed".into()),
                    Some('"') => break,
                    Some('\\') => {
                        s.push(*c.get(i + 1).ok_or("a string isn't closed")?);
                        i += 2;
                    }
                    Some(x) => {
                        s.push(*x);
                        i += 1;
                    }
                }
            }
            i += 1;
            out.push(Tok::Str(s));
        } else {
            let two: String = c[i..(i + 2).min(c.len())].iter().collect();
            let op = ["==", "!=", "&&", "||"].into_iter().find(|o| *o == two);
            if let Some(o) = op {
                out.push(Tok::Op(o));
                i += 2;
            } else {
                let one = ["?", ":", "!", "(", ")", "[", "]", ",", "."]
                    .into_iter()
                    .find(|o| o.starts_with(ch))
                    .ok_or_else(|| format!("`{ch}` isn't part of a wisp expression"))?;
                out.push(Tok::Op(one));
                i += 1;
            }
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq)]
enum E {
    Lit(Value),
    Path(String, Vec<Ix>),
    Call(String, Vec<E>),
    List(Vec<E>),
    Not(Box<E>),
    Bin(&'static str, Box<E>, Box<E>),
    Cond(Box<E>, Box<E>, Box<E>),
}

#[derive(Debug, Clone, PartialEq)]
enum Ix {
    Key(String),
    At(Box<E>),
}

struct P {
    t: Vec<Tok>,
    i: usize,
}

impl P {
    fn peek(&self) -> Option<&Tok> {
        self.t.get(self.i)
    }
    fn eat(&mut self, op: &str) -> bool {
        if matches!(self.peek(), Some(Tok::Op(o)) if *o == op) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn need(&mut self, op: &str) -> Result<(), String> {
        if self.eat(op) { Ok(()) } else { Err(format!("expected `{op}`")) }
    }
    fn expr(&mut self) -> Result<E, String> {
        let c = self.bin(0)?;
        if self.eat("?") {
            let a = self.expr()?;
            self.need(":")?;
            let b = self.expr()?;
            return Ok(E::Cond(Box::new(c), Box::new(a), Box::new(b)));
        }
        Ok(c)
    }
    fn bin(&mut self, level: usize) -> Result<E, String> {
        const LEVELS: [&[&str]; 3] = [&["||"], &["&&"], &["==", "!="]];
        if level == LEVELS.len() {
            return self.unary();
        }
        let mut l = self.bin(level + 1)?;
        while let Some(Tok::Op(o)) = self.peek().cloned() {
            if !LEVELS[level].contains(&o) {
                break;
            }
            self.i += 1;
            let r = self.bin(level + 1)?;
            l = E::Bin(o, Box::new(l), Box::new(r));
        }
        Ok(l)
    }
    fn unary(&mut self) -> Result<E, String> {
        if self.eat("!") {
            return Ok(E::Not(Box::new(self.unary()?)));
        }
        self.primary()
    }
    fn primary(&mut self) -> Result<E, String> {
        let t = self.peek().cloned().ok_or("an expression ends too soon")?;
        self.i += 1;
        match t {
            Tok::Num(n) => Ok(E::Lit(
                serde_json::Number::from_f64(n)
                    .map_or(Value::Null, |x| if n.fract() == 0.0 && n.abs() < 9e15 { Value::from(whole(n)) } else { Value::Number(x) }),
            )),
            Tok::Str(s) => Ok(E::Lit(Value::String(s))),
            Tok::Op("(") => {
                let e = self.expr()?;
                self.need(")")?;
                Ok(e)
            }
            Tok::Op("[") => {
                let mut items = Vec::new();
                while !self.eat("]") {
                    items.push(self.expr()?);
                    if !self.eat(",") {
                        self.need("]")?;
                        break;
                    }
                }
                Ok(E::List(items))
            }
            Tok::Id(id) if id == "true" || id == "false" => Ok(E::Lit(Value::Bool(id == "true"))),
            Tok::Id(id) if id == "null" => Ok(E::Lit(Value::Null)),
            Tok::Id(id) => {
                if self.eat("(") {
                    let mut args = Vec::new();
                    while !self.eat(")") {
                        args.push(self.expr()?);
                        if !self.eat(",") {
                            self.need(")")?;
                            break;
                        }
                    }
                    return Ok(E::Call(id, args));
                }
                let mut ix = Vec::new();
                loop {
                    if self.eat(".") {
                        match self.peek().cloned() {
                            Some(Tok::Id(k)) => ix.push(Ix::Key(k)),
                            Some(Tok::Num(n)) => ix.push(Ix::Key(n.to_string())),
                            _ => return Err(format!("`{id}.` needs a name after the dot")),
                        }
                        self.i += 1;
                    } else if self.eat("[") {
                        ix.push(Ix::At(Box::new(self.expr()?)));
                        self.need("]")?;
                    } else {
                        break;
                    }
                }
                Ok(E::Path(id, ix))
            }
            Tok::Op(o) => Err(format!("`{o}` can't start an expression")),
        }
    }
}

/// A whole number that fits (checked by the caller: no fraction, under 9e15).
#[allow(clippy::cast_possible_truncation)]
fn whole(n: f64) -> i64 {
    n as i64
}

fn parse(src: &str) -> Result<E, String> {
    let mut p = P { t: lex(src)?, i: 0 };
    let e = p.expr()?;
    if p.i != p.t.len() {
        return Err(format!("`{src}`: more after the expression"));
    }
    Ok(e)
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::Null => false,
        Value::String(s) => !s.is_empty() && s != "false",
        Value::Number(n) => n.as_f64() != Some(0.0),
        _ => true,
    }
}

fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn arg(a: &[Value], i: usize) -> Value {
    a.get(i).cloned().unwrap_or(Value::Null)
}

fn call(f: &str, a: &[Value], s: &dyn Scope) -> Result<Value, String> {
    let list = |v: &Value| v.as_array().cloned().unwrap_or_default();
    Ok(match f {
        "lower" => Value::String(text(&arg(a, 0)).to_lowercase()),
        "upper" => Value::String(text(&arg(a, 0)).to_uppercase()),
        "join" => Value::String(list(&arg(a, 1)).iter().map(text).collect::<Vec<_>>().join(&text(&arg(a, 0)))),
        "split" => Value::Array(text(&arg(a, 1)).split(text(&arg(a, 0)).as_str()).map(|x| Value::String(x.to_owned())).collect()),
        "replace" => Value::String(text(&arg(a, 0)).replace(&text(&arg(a, 1)), &text(&arg(a, 2)))),
        "length" => Value::from(match arg(a, 0) {
            Value::Array(x) => x.len(),
            Value::Object(m) => m.len(),
            v => text(&v).chars().count(),
        }),
        "contains" => Value::Bool(match arg(a, 0) {
            Value::Array(x) => x.contains(&arg(a, 1)),
            v => text(&v).contains(&text(&arg(a, 1))),
        }),
        "keys" => Value::Array(arg(a, 0).as_object().map(|m| m.keys().map(|k| Value::String(k.clone())).collect()).unwrap_or_default()),
        "values" => Value::Array(arg(a, 0).as_object().map(|m| m.values().cloned().collect()).unwrap_or_default()),
        "concat" => Value::Array(a.iter().flat_map(list).collect()),
        "coalesce" => a.iter().find(|v| !v.is_null() && **v != Value::String(String::new())).cloned().unwrap_or(Value::Null),
        "tostring" => Value::String(text(&arg(a, 0))),
        "secret" => Value::String(format!("${{secret:{}}}", text(&arg(a, 0)))),
        "file" | "env" => s.outside(f, &text(&arg(a, 0)))?,
        _ => {
            return Err(format!(
                "{f}() isn't a wisp function (lower, upper, join, split, replace, length, contains, keys, values, concat, coalesce, tostring, file, env, secret)"
            ));
        }
    })
}

#[allow(clippy::many_single_char_names)] // the grammar's short names: e, s, l, r, a, b
fn eval(e: &E, s: &dyn Scope) -> Result<Value, String> {
    match e {
        E::Lit(v) => Ok(v.clone()),
        E::List(items) => items.iter().map(|x| eval(x, s)).collect::<Result<Vec<_>, _>>().map(Value::Array),
        E::Not(x) => Ok(Value::Bool(!truthy(&eval(x, s)?))),
        E::Cond(c, a, b) => {
            if truthy(&eval(c, s)?) {
                eval(a, s)
            } else {
                eval(b, s)
            }
        }
        E::Bin(op, l, r) => {
            let l = eval(l, s)?;
            Ok(match *op {
                "&&" => Value::Bool(truthy(&l) && truthy(&eval(r, s)?)),
                "||" => {
                    if truthy(&l) {
                        Value::Bool(true)
                    } else {
                        Value::Bool(truthy(&eval(r, s)?))
                    }
                }
                "==" => Value::Bool(l == eval(r, s)?),
                _ => Value::Bool(l != eval(r, s)?),
            })
        }
        E::Call(f, args) => {
            let a = args.iter().map(|x| eval(x, s)).collect::<Result<Vec<_>, _>>()?;
            call(f, &a, s)
        }
        E::Path(head, ix) => {
            let mut path = vec![Seg::Key(head.clone())];
            for i in ix {
                path.push(match i {
                    Ix::Key(k) => Seg::Key(k.clone()),
                    Ix::At(x) => match eval(x, s)? {
                        Value::Number(n) => {
                            Seg::Index(usize::try_from(n.as_u64().ok_or("an index is a whole number")?).unwrap_or(usize::MAX))
                        }
                        v => Seg::Key(text(&v)),
                    },
                });
            }
            s.get(&path)
        }
    }
}

/// The `${…}` pieces of a string: (start, end, inner) with `end` past the closing brace. `$${` and the
/// `${secret:…}` / `${env:…}` references are skipped.
fn pieces(s: &str) -> Vec<(usize, usize, String)> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < b.len() {
        if b[i] == b'$' && b[i + 1] == b'$' && b.get(i + 2) == Some(&b'{') {
            i += 3;
            continue;
        }
        if b[i] == b'$' && b[i + 1] == b'{' {
            let (mut depth, mut j, mut quoted) = (1, i + 2, false);
            while j < b.len() && depth > 0 {
                match b[j] {
                    b'\\' if quoted => j += 1,
                    b'"' => quoted = !quoted,
                    b'{' if !quoted => depth += 1,
                    b'}' if !quoted => depth -= 1,
                    _ => {}
                }
                j += 1;
            }
            if depth != 0 {
                break;
            }
            let inner = &s[i + 2..j - 1];
            let head: String = inner.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
            if !(inner[head.len()..].starts_with(':') && (head == "secret" || head == "env")) {
                out.push((i, j, inner.to_owned()));
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// A string evaluated: exactly `${x}` is x's value (any type); otherwise each piece is put in as text.
pub fn eval_str(s: &str, scope: &dyn Scope) -> Result<Value, String> {
    let ps = pieces(s);
    if ps.is_empty() {
        return Ok(Value::String(s.replace("$${", "${")));
    }
    if ps.len() == 1 && ps[0].0 == 0 && ps[0].1 == s.len() {
        return eval(&parse(&ps[0].2).map_err(|e| format!("${{{}}}: {e}", ps[0].2))?, scope);
    }
    let mut out = String::new();
    let mut at = 0;
    for (a, b, inner) in ps {
        out.push_str(&s[at..a].replace("$${", "${"));
        out.push_str(&text(&eval(&parse(&inner).map_err(|e| format!("${{{inner}}}: {e}"))?, scope)?));
        at = b;
    }
    out.push_str(&s[at..].replace("$${", "${"));
    Ok(Value::String(out))
}

/// Every string in `v` evaluated, keys included.
pub fn eval_value(v: &Value, scope: &dyn Scope) -> Result<Value, String> {
    Ok(match v {
        Value::String(s) => eval_str(s, scope)?,
        Value::Array(a) => Value::Array(a.iter().map(|x| eval_value(x, scope)).collect::<Result<_, _>>()?),
        Value::Object(m) => {
            let mut o = Map::new();
            for (k, x) in m {
                o.insert(eval_str(k, scope).map(|k| text(&k))?, eval_value(x, scope)?);
            }
            Value::Object(o)
        }
        other => other.clone(),
    })
}

fn paths(e: &E, out: &mut Vec<Vec<String>>) {
    match e {
        E::Path(h, ix) => {
            let mut p = vec![h.clone()];
            for i in ix {
                match i {
                    Ix::Key(k) => p.push(k.clone()),
                    Ix::At(x) => {
                        paths(x, out);
                        break;
                    }
                }
            }
            out.push(p);
        }
        E::Call(_, a) | E::List(a) => a.iter().for_each(|x| paths(x, out)),
        E::Not(x) => paths(x, out),
        E::Bin(_, a, b) => {
            paths(a, out);
            paths(b, out);
        }
        E::Cond(a, b, c) => {
            paths(a, out);
            paths(b, out);
            paths(c, out);
        }
        E::Lit(_) => {}
    }
}

/// The references in `v`'s expressions, as name paths (`["agent", "reviewer", "model"]`). An expression
/// that doesn't parse is reported when it's evaluated.
pub fn refs(v: &Value) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    match v {
        Value::String(s) => {
            for (_, _, inner) in pieces(s) {
                if let Ok(e) = parse(&inner) {
                    paths(&e, &mut out);
                }
            }
        }
        Value::Array(a) => a.iter().for_each(|x| out.extend(refs(x))),
        Value::Object(m) => m.iter().for_each(|(k, x)| {
            out.extend(refs(&Value::String(k.clone())));
            out.extend(refs(x));
        }),
        _ => {}
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;

    struct S(Value);
    impl Scope for S {
        fn get(&self, path: &[Seg]) -> Result<Value, String> {
            let mut v = &self.0;
            for p in path {
                v = match p {
                    Seg::Key(k) => v.get(k),
                    Seg::Index(i) => v.get(*i),
                }
                .ok_or_else(|| format!("no {p:?}"))?;
            }
            Ok(v.clone())
        }
        fn outside(&self, f: &str, a: &str) -> Result<Value, String> {
            Ok(json!(format!("{f}:{a}")))
        }
    }

    fn s() -> S {
        S(
            json!({ "var": { "model": "opus", "n": 3, "on": true, "tags": ["a", "b"] }, "agent": { "reviewer": { "name": "reviewer", "harness": "codex" } } }),
        )
    }

    #[test]
    fn references_literals_operators_and_functions() {
        let e = |x: &str| eval_str(x, &s()).unwrap();
        assert_eq!(e("${var.model}"), json!("opus"));
        assert_eq!(e("${var.n}"), json!(3), "a whole `${{}}` keeps its type");
        assert_eq!(e("model: ${var.model}, ${var.n}x"), json!("model: opus, 3x"));
        assert_eq!(e("${agent.reviewer.harness == \"codex\" ? \"high\" : \"low\"}"), json!("high"));
        assert_eq!(e("${!var.on || var.n == 3}"), json!(true));
        assert_eq!(e("${upper(join(\",\", var.tags))}"), json!("A,B"));
        assert_eq!(e("${var.tags[1]}"), json!("b"));
        assert_eq!(e("${length(var.tags)}"), json!(2));
        assert_eq!(e("${secret(\"LINEAR\")}"), json!("${secret:LINEAR}"));
        assert_eq!(e("${file(\"x.md\")}"), json!("file:x.md"));
        assert_eq!(e("keep ${secret:TOKEN} and ${env:HOME} and $${literal}"), json!("keep ${secret:TOKEN} and ${env:HOME} and ${literal}"));
        assert!(eval_str("${nope.x}", &s()).is_err());
        assert!(eval_str("${exec(\"rm\")}", &s()).unwrap_err().contains("isn't a wisp function"));
        assert_eq!(
            refs(&json!({ "a": "${agent.reviewer.harness} ${var.tags[var.n]}" })),
            vec![
                vec!["agent".to_owned(), "reviewer".into(), "harness".into()],
                vec!["var".into(), "n".into()],
                vec!["var".into(), "tags".into()]
            ]
        );
    }

    /// Property: no string panics the evaluator, and a string with no `${` comes back as it is.
    #[test]
    fn any_input_is_safe() {
        let alphabet: Vec<char> = "${}\"\\ab.[]()!=&|?:,0 9_-x".chars().collect();
        let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
        for _ in 0..20_000 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let len = usize::try_from(seed % 24).unwrap_or(0);
            let mut t = String::new();
            let mut x = seed;
            for _ in 0..len {
                x = x.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
                t.push(alphabet[usize::try_from(x >> 33).unwrap_or(0) % alphabet.len()]);
            }
            let r = eval_str(&t, &s());
            if !t.contains("${") {
                assert_eq!(r.unwrap(), json!(t.replace("$${", "${")));
            }
            let _ = refs(&json!(t));
        }
    }
}
