//! `wisp mcp`'s crew tools (v1 server/mcp-wisp.js `wisp_crew*`): the user's editor reads and changes the crew
//! through crew's own typed commands, as the user. v1's words are `wisp_mcp_core::user`'s.

use serde_json::{Map, Value, json};
use wisp_crew_api::commands as c;
use wisp_kernel::{Call, Command, Ctx};
use wisp_mcp_core::{Outcome, user};

type Args = Map<String, Value>;

async fn run<C: Command>(ctx: &Ctx, call: &Call, v: Value) -> Result<Value, String> {
    let args: C::Args = serde_json::from_value(v).map_err(|e| format!("{}: {e}", C::ID))?;
    let out = ctx.run::<C>(call, args).await.map_err(|e| e.message)?;
    serde_json::to_value(out).map_err(|e| e.to_string())
}

fn done(r: Result<String, String>) -> Outcome {
    r.map_or_else(Outcome::Failed, Outcome::Text)
}

/// `wisp_crew`, `wisp_crew_add`, `wisp_crew_edit`, `wisp_crew_remove`; `None` for any other name.
pub(crate) async fn tool(ctx: &Ctx, call: &Call, name: &str, a: &Args, cwd: Option<&str>) -> Option<Outcome> {
    Some(done(match name {
        "wisp_crew" => list(ctx, call, a).await,
        "wisp_crew_add" => add(ctx, call, a, cwd).await,
        "wisp_crew_edit" => edit(ctx, call, a).await,
        "wisp_crew_remove" => remove(ctx, call, a).await,
        _ => return None,
    }))
}

async fn list(ctx: &Ctx, call: &Call, a: &Args) -> Result<String, String> {
    let member = user::handle(a.get("member"));
    if !member.is_empty() {
        return Ok(user::member_detail(&run::<c::Get>(ctx, call, json!({ "id": member })).await?));
    }
    let all = run::<c::List>(ctx, call, json!({})).await?;
    let all = all.as_array().cloned().unwrap_or_default();
    Ok(if all.is_empty() { user::NO_CREW.to_owned() } else { all.iter().map(user::member_line).collect::<Vec<_>>().join("\n") })
}

async fn add(ctx: &Ctx, call: &Call, a: &Args, cwd: Option<&str>) -> Result<String, String> {
    let here = a.get("cwd").cloned().unwrap_or_else(|| cwd.map_or(Value::Null, |c| Value::String(c.to_owned())));
    if let Some(from) = a.get("from").and_then(Value::as_str).filter(|f| !f.trim().is_empty()) {
        let mut src = user::crew_source(from);
        src["dryRun"] = Value::Bool(true);
        let review = run::<c::Import>(ctx, call, src.clone()).await?;
        if review.get("spell").is_some_and(|s| !s.is_null()) {
            return Ok(user::SPELL_NOT_CREW.to_owned());
        }
        let choices: Map<String, Value> = review
            .get("members")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|m| m.get("key").and_then(Value::as_str).map(|k| (k.to_owned(), json!({ "cwd": here }))))
            .collect();
        let mut take = user::crew_source(from);
        take["choices"] = Value::Object(choices);
        let r = run::<c::Import>(ctx, call, take).await?;
        return Ok(user::imported(r.get("members").and_then(Value::as_array).map_or(&[][..], Vec::as_slice)));
    }
    let mut body = user::pick(a);
    body.entry("cwd").or_insert(here);
    body.insert("checkin".into(), Value::Bool(a.get("checkin") == Some(&Value::Bool(true))));
    Ok(user::added(&run::<c::Create>(ctx, call, Value::Object(body)).await?))
}

async fn edit(ctx: &Ctx, call: &Call, a: &Args) -> Result<String, String> {
    let id = user::handle(a.get("member"));
    let mut body = user::pick(a);
    if a.get("remember").is_some() {
        let notebook = match body.get("notebook") {
            Some(n) => user::as_text(n),
            None => user::as_text(run::<c::Get>(ctx, call, json!({ "id": id })).await?.get("notebook").unwrap_or(&Value::Null)),
        };
        if let Some(n) = user::remembered(&notebook, a.get("remember")) {
            body.insert("notebook".into(), Value::String(n));
        }
    }
    body.insert("id".into(), Value::String(id));
    Ok(user::updated(&run::<c::Update>(ctx, call, Value::Object(body)).await?))
}

async fn remove(ctx: &Ctx, call: &Call, a: &Args) -> Result<String, String> {
    let m = run::<c::Get>(ctx, call, json!({ "id": user::handle(a.get("member")) })).await?;
    let id = m.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
    run::<c::Remove>(ctx, call, json!({ "id": id })).await?;
    Ok(user::removed(&m))
}
