//! Per-turn selection (v1 `turnServers`): which connectors one turn gets, as `mcpServers` entries
//! that start the proxy by connector id. No secret is ever in an entry: the proxy fetches them.

use std::collections::{BTreeMap, BTreeSet};

use wisp_connectors_api::{Connector, Launcher, McpServer, McpServers, TurnQuery};

/// What every entry carries: the launcher (`wisp connector`) and the proxy's env.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProxyLaunch {
    pub launcher: Launcher,
    pub env: BTreeMap<String, String>,
}

/// The proxy's env: wisp's home, and with a bridge, wisp's URL and the connectors token (never the
/// master token: it may run `connectors.spec` and `connectors.token` only).
pub fn proxy_env(home: &str, bridge: Option<(&str, &str)>) -> BTreeMap<String, String> {
    let mut env = BTreeMap::from([("WISP_HOME".to_owned(), home.to_owned())]);
    if let Some((url, token)) = bridge {
        env.insert("WISP_URL".into(), url.to_owned());
        env.insert("WISP_TOKEN".into(), token.to_owned());
    }
    env
}

/// The connectors one turn gets. Plan mode gets none (their tools would run outside a read-only
/// sandbox, already approved), nor does a harness that takes no servers per turn (`reach` false);
/// one that is off is left out; a harness with a server by that name in its own config (`own`) keeps
/// its own.
pub fn turn_servers(list: &[Connector], q: &TurnQuery, reach: bool, own: &BTreeSet<String>, launch: &ProxyLaunch) -> McpServers {
    if q.mode == "plan" || !reach {
        return McpServers::new();
    }
    list.iter()
        .filter(|c| c.enabled && !own.contains(&c.name))
        .map(|c| {
            let mut args = launch.launcher.args.clone();
            args.push(c.id.clone());
            (c.name.clone(), McpServer { command: launch.launcher.command.clone(), args, env: launch.env.clone() })
        })
        .collect()
}
