//! wisp.accounts' commands, by the ids the UI binds (plugins/accounts/ui/src/commands.ts) and v1's
//! routes (server/routes/meta.js `/agents/:id/accounts`, `/login`, `/logout`, `/trust`). Bodies are
//! v1's (camelCase) plus the ids the route took from its path.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use wisp_kernel::Command;

use crate::model::{AccountView, AccountsOut, AddOut, LoginStatus, LoginView, WatchView};
use crate::{PERM_LOGIN, PERM_READ, PERM_WRITE};

macro_rules! command {
    ($(#[$m:meta])* $name:ident = $id:literal [$perm:expr] : $args:ty => $out:ty $(, $ro:ident)?) => {
        $(#[$m])*
        #[derive(Debug)]
        pub struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            const PERMISSION: Option<&'static str> = Some($perm);
            $(const READ_ONLY: bool = { let _ = stringify!($ro); true };)?
            type Args = $args;
            fn args_ts() -> Option<String> {
                Some(format!("{}{}", <$args as ::ts_rs::TS>::docs().unwrap_or_default(), <$args as ::ts_rs::TS>::inline(&::ts_rs::Config::default())))
            }
            type Out = $out;
        }
    };
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "accounts/")]
pub struct AgentArgs {
    pub agent: String,
}

/// `accounts.install`'s args: the harness, and what npm installs (default: its own package, latest).
/// Additive (2026-11-09): `package` (`name` or `name@version`, from the `harness` kind's `pin`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "accounts/")]
pub struct InstallArgs {
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub package: Option<String>,
}

/// `account`: '' (or 'default') for the CLI's own login.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "accounts/")]
pub struct AccountArgs {
    pub agent: String,
    #[serde(default)]
    pub account: String,
}

/// `id` is made by the client, so the row that shows at once is the row kept.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "accounts/")]
pub struct AddArgs {
    pub agent: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub kind: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "accounts/")]
pub struct UpdateArgs {
    pub agent: String,
    pub account: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind: Option<String>,
    /// 'up' | 'down'
    #[serde(default, rename = "move", skip_serializing_if = "Option::is_none")]
    #[ts(optional, rename = "move")]
    pub mv: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "accounts/")]
pub struct LoginInputArgs {
    pub agent: String,
    #[serde(default)]
    pub account: String,
    pub code: String,
}

/// A harness's accounts and its watch, for the list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "accounts/")]
pub struct HarnessAccounts {
    pub agent: String,
    pub accounts: Vec<AccountView>,
    pub watch: WatchView,
}

command!(
    /// GET /agents/:id/accounts
    List = "accounts.list" [PERM_READ] : AgentArgs => AccountsOut, ro
);
command!(
    /// Every harness that can have several accounts, with its watch (the harness list's extras).
    Harnesses = "accounts.harnesses" [PERM_READ] : () => Vec<HarnessAccounts>, ro
);
command!(
    /// POST /agents/:id/accounts: the new account; its sign-in starts at once.
    Add = "accounts.add" [PERM_WRITE] : AddArgs => AddOut
);
command!(
    /// PATCH /agents/:id/accounts/:acc
    Update = "accounts.update" [PERM_WRITE] : UpdateArgs => AccountsOut
);
command!(
    /// DELETE /agents/:id/accounts/:acc: signs it out and forgets it.
    Remove = "accounts.remove" [PERM_WRITE] : AccountArgs => AccountsOut
);
command!(
    /// GET /agents/:id/watch: its pin and open change.
    Watch = "accounts.watch" [PERM_READ] : AgentArgs => WatchView, ro
);
command!(
    /// POST /agents/:id/trust: what's there now becomes the pin, and turns it held run again.
    Trust = "accounts.watch.trust" [PERM_WRITE] : AgentArgs => WatchView
);
command!(
    /// GET /agents/:id/login: the sign-in as it stands.
    Login = "accounts.login" [PERM_READ] : AccountArgs => LoginView, ro
);
command!(
    /// POST /agents/:id/login: runs the CLI's own login.
    LoginStart = "accounts.login.start" [PERM_LOGIN] : AccountArgs => LoginView
);
command!(
    /// POST /agents/:id/login/input: the code the sign-in page showed, pasted back.
    LoginInput = "accounts.login.input" [PERM_LOGIN] : LoginInputArgs => LoginView
);
command!(
    /// DELETE /agents/:id/login
    LoginCancel = "accounts.login.cancel" [PERM_LOGIN] : AccountArgs => LoginView
);
command!(
    /// Signed in or not, and as whom (the CLI's own status).
    Status = "accounts.login.status" [PERM_READ] : AccountArgs => LoginStatus
);
command!(
    /// POST /agents/:id/logout: the CLI's own sign-out.
    Logout = "accounts.logout" [PERM_LOGIN] : AccountArgs => LoginStatus
);

/// Ask before running a changed harness (v1 `defaults.harnessAsk`), until wisp.settings owns it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "accounts/")]
pub struct AskArgs {
    pub on: bool,
}

command!(
    /// Settings → Agents → Ask before running a changed harness.
    SetAsk = "accounts.watch.ask" [PERM_WRITE] : AskArgs => AskArgs
);

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "accounts/")]
pub struct ProviderArgs {
    pub agent: String,
    pub provider: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "accounts/")]
pub struct KeySetArgs {
    pub agent: String,
    pub provider: String,
    pub key: String,
}

/// Did the provider take the key (one model list with it, nothing spent).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "accounts/")]
pub struct KeyTested {
    pub ok: bool,
    pub message: String,
}

command!(
    /// GET /agents/:id/keys: which providers have a key, never the key.
    Keys = "accounts.keys" [PERM_READ] : AgentArgs => crate::model::KeysView, ro
);
command!(
    /// POST /agents/:id/keys
    KeySet = "accounts.keys.set" [crate::PERM_KEYS] : KeySetArgs => crate::model::KeysView
);
command!(
    /// DELETE /agents/:id/keys/:provider
    KeyRemove = "accounts.keys.remove" [crate::PERM_KEYS] : ProviderArgs => crate::model::KeysView
);
command!(
    /// Settings → API keys → Test.
    KeyTest = "accounts.keys.test" [PERM_READ] : ProviderArgs => KeyTested
);
command!(
    /// POST /agents/install: a harness wisp can install itself (opencode), into its tools folder.
    Install = "accounts.install" [PERM_WRITE] : InstallArgs => serde_json::Value
);
command!(
    /// POST /agents/recheck: every harness detected again.
    Recheck = "accounts.recheck" [PERM_READ] : () => serde_json::Value
);
command!(
    /// A read of the account's usage windows that spends nothing (Codex's app-server); null: none.
    Limits = "accounts.limits" [PERM_READ] : AccountArgs => serde_json::Value, ro
);
