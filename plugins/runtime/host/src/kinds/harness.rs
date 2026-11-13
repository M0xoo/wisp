//! The `harness` kind: a harness CLI as declared (where it comes from, its pin, its defaults), what that does
//! to `runtime.agents`, and the install `from: npm|brew` runs on apply.

use serde::{Deserialize, Serialize};
use schemars::JsonSchema;
use serde_json::Value;
use wisp_kernel::Setup;
use wisp_resources_api::KindInfo;

/// A harness CLI: where it comes from, which version is trusted, its own defaults.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HarnessSpec {
    /// installed or not (false: wisp never offers it)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// npm | brew | path
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub from: String,
    /// its program when `from: path`
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub path: String,
    /// the version wisp trusts (a newer one asks first); `from: npm` installs this one
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub pin: String,
    /// what `from` installs: the npm package (default: the harness's own) or the brew formula
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub package: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub model: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub effort: String,
    /// lean runs: wisp's short base prompt instead of the harness's own
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lean: Option<bool>,
    /// read its usage limits while it runs
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_limits: Option<bool>,
}

/// `runtime.agents` with what `harnesses:` declares: one that's off isn't offered (not available, and
/// why), and one whose version isn't the pinned one says so (it still runs: a newer one asks first).
pub fn declared(list: &mut [wisp_runtime_api::commands::AgentStatus], specs: &[(String, Value)]) {
    for a in list.iter_mut() {
        let Some(h) = specs.iter().find(|(n, _)| *n == a.id).and_then(|(_, v)| serde_json::from_value::<HarnessSpec>(v.clone()).ok()) else { continue };
        if h.enabled == Some(false) {
            a.available = false;
            a.error = Some(format!("switched off (harnesses: {}: {{ enabled: false }})", a.id));
        } else if !h.pin.is_empty() && a.version.as_deref().is_some_and(|v| !v.trim_start_matches('v').starts_with(h.pin.trim_start_matches('v'))) {
            a.error = Some(format!("{} isn't the pinned {} (harnesses: {}: {{ pin }})", a.version.clone().unwrap_or_default(), h.pin, a.id));
        }
    }
}

/// How a harness gets installed when it's applied: what to run, if anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Install {
    /// `npm install <pkg>@<version>` into wisp's tools folder (`accounts.install`)
    Npm(String),
    /// `brew install <formula>`
    Brew(String),
}

/// `from: npm|brew` installs a harness that isn't there, or whose version isn't its pin. `npm_package`
/// is the harness's own (opencode's); a spec's `package` names another.
pub fn install_plan(h: &HarnessSpec, available: bool, version: Option<&str>, npm_package: Option<&str>) -> Option<Install> {
    if h.enabled == Some(false) {
        return None;
    }
    let pinned = h.pin.trim_start_matches('v');
    let wrong = !pinned.is_empty() && version.is_some_and(|v| !v.trim_start_matches('v').starts_with(pinned));
    if available && !wrong {
        return None;
    }
    let pkg = Some(h.package.clone()).filter(|p| !p.is_empty());
    match h.from.as_str() {
        "npm" => pkg.or_else(|| npm_package.map(str::to_owned)).map(Install::Npm),
        "brew" => pkg.map(Install::Brew),
        _ => None,
    }
}

/// The `harness` kind: kept as declared, and `from: npm|brew` installs it on apply.
struct HarnessKind(std::sync::Arc<wisp_resources_api::StoredKind>);

impl HarnessKind {
    async fn install(&self, name: &str, h: &HarnessSpec) -> wisp_kernel::Result<()> {
        let ctx = &self.0.ctx;
        let call = ctx.root_call();
        let agents = ctx.run_json(&call, "runtime.agents", serde_json::json!({})).await.unwrap_or_default();
        let me = agents.as_array().and_then(|l| l.iter().find(|a| a["id"] == name).cloned()).unwrap_or_default();
        let npm = ctx.contributions(&wisp_runtime_api::harness::HARNESS).into_iter().find(|x| x.info().id == name).and_then(|x| x.npm_package());
        let plan = install_plan(h, me["available"] == true, me["version"].as_str(), npm.as_deref());
        match plan {
            None => Ok(()),
            Some(Install::Npm(pkg)) => {
                let want = if h.pin.is_empty() { pkg } else { format!("{pkg}@{}", h.pin.trim_start_matches('v')) };
                ctx.run::<wisp_accounts_api::commands::Install>(&call, wisp_accounts_api::commands::InstallArgs { agent: name.to_owned(), package: Some(want) }).await.map(drop)
            }
            Some(Install::Brew(formula)) => {
                let proc = ctx.service::<wisp_proc::Proc>()?;
                let brew = std::env::var("WISP_BREW").ok().filter(|b| !b.is_empty()).unwrap_or_else(|| "brew".into());
                let opts = wisp_proc::ExecOpts { timeout: Some(std::time::Duration::from_secs(600)), ..wisp_proc::ExecOpts::default() };
                let r = proc.exec(&brew, &["install".to_owned(), formula.clone()], opts).await.map_err(|e| wisp_kernel::WireError::invalid(format!("brew isn't there to install {formula}: {e}")))?;
                if r.exit.success() { Ok(()) } else { Err(wisp_kernel::WireError::invalid(format!("brew install {formula} failed: {}", r.stderr_text().trim()))) }
            }
        }
    }
}

impl wisp_resources_api::ResourceKind for HarnessKind {
    fn info(&self) -> KindInfo {
        self.0.info()
    }
    fn read<'a>(&'a self, call: &'a wisp_kernel::Call) -> wisp_kernel::BoxFuture<'a, wisp_kernel::Result<Vec<wisp_resources_api::Resource>>> {
        self.0.read(call)
    }
    fn describe(&self, op: &wisp_resources_api::Op) -> Option<String> {
        let from = op.spec.get("from").and_then(Value::as_str).filter(|f| matches!(*f, "npm" | "brew"))?;
        Some(format!("installs {} with {from} if it isn't there", op.name))
    }
    fn apply<'a>(&'a self, call: &'a wisp_kernel::Call, op: &'a wisp_resources_api::Op) -> wisp_kernel::BoxFuture<'a, wisp_kernel::Result<()>> {
        Box::pin(async move {
            if op.op != wisp_resources_api::OpKind::Delete {
                let h: HarnessSpec = serde_json::from_value(op.spec.clone()).unwrap_or_default();
                self.install(&op.name, &h).await?;
            }
            self.0.apply(call, op).await
        })
    }
}

pub(super) fn harness_kind(s: &mut Setup) -> std::sync::Arc<wisp_resources_api::StoredKind> {
    let inner = std::sync::Arc::new(wisp_resources_api::StoredKind::new(KindInfo::new("harness", "harnesses", "wisp.runtime", wisp_resources_api::schema_of::<HarnessSpec>()).order(12), s.ctx()));
    let k: std::sync::Arc<dyn wisp_resources_api::ResourceKind> = std::sync::Arc::new(HarnessKind(inner.clone()));
    s.contribute(&wisp_resources_api::RESOURCE_KIND, k);
    inner
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_harness_installs_only_when_missing_or_off_its_pin() {
        let npm = HarnessSpec { from: "npm".into(), ..HarnessSpec::default() };
        assert_eq!(install_plan(&npm, true, Some("1.2.0"), Some("opencode-ai")), None);
        assert_eq!(install_plan(&npm, false, None, Some("opencode-ai")), Some(Install::Npm("opencode-ai".into())));
        assert_eq!(install_plan(&npm, false, None, None), None, "no package: nothing to install");
        let pinned = HarnessSpec { pin: "0.60.0".into(), package: "@openai/codex".into(), ..npm.clone() };
        assert_eq!(install_plan(&pinned, true, Some("0.61.2"), None), Some(Install::Npm("@openai/codex".into())));
        assert_eq!(install_plan(&pinned, true, Some("v0.60.0"), None), None);
        let brew = HarnessSpec { from: "brew".into(), package: "grok-cli".into(), ..HarnessSpec::default() };
        assert_eq!(install_plan(&brew, false, None, None), Some(Install::Brew("grok-cli".into())));
        assert_eq!(install_plan(&HarnessSpec { enabled: Some(false), ..brew }, false, None, None), None);
    }
}
