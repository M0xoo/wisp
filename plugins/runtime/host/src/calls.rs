//! wisp.runtime's calls to other plugins, through their typed commands (ADR-0003: `wisp-budget-api`,
//! `wisp-accounts-api`, `wisp-later-api`, `wisp-stuff-api`, `wisp-machines-api`, `wisp-sandbox-api`). The runtime
//! reaches the kernel through its `Host` seam (tests answer by id), so a call goes out as `C::ID` with `C::Args`
//! and its answer is read as `C::Out`: an answer in a shape the command doesn't declare is a refusal, never a
//! silent default. None of those crates depends on wisp-runtime, so there is no cycle.

use wisp_kernel::{Command, Result, WireError};

use crate::host::Host;

/// Command `C` through the host, typed both ways.
pub(crate) async fn run<C: Command>(host: &dyn Host, args: C::Args) -> Result<C::Out> {
    let v = serde_json::to_value(args).map_err(|e| WireError::invalid(format!("{}: {e}", C::ID)))?;
    let out = host.command(C::ID, v).await?;
    decode::<C>(out)
}

/// `C`'s answer as it declares it.
pub(crate) fn decode<C: Command>(v: serde_json::Value) -> Result<C::Out> {
    serde_json::from_value(v).map_err(|e| WireError::invalid(format!("{} answered in a shape it doesn't declare: {e}", C::ID)))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Each answer runtime reads is the target's declared shape: what wisp.accounts, wisp.later, wisp.stuff and
    /// wisp.sandbox send back decodes, and a partial one (a test fake's `{ "id": "l1" }`) is refused, not read as
    /// "nothing waited".
    #[test]
    fn answers_are_read_in_the_shape_each_command_declares() {
        let cool = json!({ "accounts": [{ "id": "w", "label": "Work", "email": "", "plan": "", "default": false, "kind": "work", "state": "ready", "until": null, "why": "" }] });
        assert_eq!(decode::<wisp_accounts_api::commands::Cool>(cool).unwrap().accounts[0].id, "w");
        assert!(decode::<wisp_later_api::commands::WaitAtLimit>(json!({ "id": "l1" })).is_err());
        assert!(decode::<wisp_later_api::commands::WaitAtLimit>(json!(null)).unwrap().is_none(), "null: later asks the user");
        assert_eq!(decode::<wisp_stuff_api::commands::Describe>(json!({ "text": "- logo.png" })).unwrap().unwrap().text, "- logo.png");
        let b = decode::<wisp_sandbox_api::Bring>(json!({ "files": 2 })).unwrap();
        assert_eq!((b.files, b.error), (2, None));
        assert_eq!(decode::<wisp_budget_api::commands::ResetAt>(json!(5)).unwrap(), Some(5));
    }
}
