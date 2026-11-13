//! Signing in with an API key pasted into wisp (v1 agent-login.js `keysOf`, `setKey`, `removeKey`):
//! the key goes where the CLI keeps it (`Harness::keys().file`, `{ provider: { type: 'api', key } }`),
//! never in wisp's database; wisp only ever says which providers have one.

use serde_json::{Map, Value, json};
use wisp_accounts_api::{KeyProviderView, KeysView};
use wisp_kernel::WireError;
use wisp_runtime_api::harness::HarnessKeys;

async fn read(file: &str) -> Result<Map<String, Value>, WireError> {
    match tokio::fs::read_to_string(file).await {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(WireError::invalid(e.to_string())),
        Ok(t) if t.trim().is_empty() => Ok(Map::new()),
        // never overwrite a file we can't read: it holds the user's other providers' logins too
        Ok(t) => serde_json::from_str::<Value>(&t)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .ok_or_else(|| WireError::conflict(format!("wisp can’t read {file}: fix or remove it, then try again."))),
    }
}

pub async fn view(agent: &str, k: &HarnessKeys) -> Result<KeysView, WireError> {
    let auth = read(&k.file).await?;
    Ok(KeysView {
        agent: agent.into(),
        url: k.url.clone(),
        env: if std::env::var(&k.env).is_ok_and(|v| !v.is_empty()) { k.env.clone() } else { String::new() },
        providers: k
            .providers
            .iter()
            .map(|p| KeyProviderView { id: p.id.clone(), name: p.name.clone(), set: auth.contains_key(&p.id) })
            .collect(),
    })
}

fn provider<'a>(k: &'a HarnessKeys, pid: &str) -> Result<&'a str, WireError> {
    k.providers.iter().find(|p| p.id == pid).map(|p| p.id.as_str()).ok_or_else(|| {
        WireError::invalid(format!("Pick one of {}.", k.providers.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", ")))
    })
}

pub async fn set(agent: &str, k: &HarnessKeys, pid: &str, key: &str) -> Result<KeysView, WireError> {
    let pid = provider(k, pid)?;
    let v = key.trim();
    if v.is_empty() || v.len() > 500 || v.contains(char::is_whitespace) {
        return Err(WireError::invalid(format!("Paste the API key from {}.", k.url)));
    }
    let mut auth = read(&k.file).await?;
    auth.insert(pid.to_owned(), json!({ "type": "api", "key": v }));
    let text = format!("{}\n", serde_json::to_string_pretty(&Value::Object(auth)).unwrap_or_default());
    crate::sys::write_atomic(std::path::Path::new(&k.file), text.as_bytes()).await.map_err(|e| WireError::invalid(e.to_string()))?;
    view(agent, k).await
}

pub async fn remove(agent: &str, k: &HarnessKeys, pid: &str) -> Result<KeysView, WireError> {
    let pid = provider(k, pid)?;
    let mut auth = read(&k.file).await?;
    if auth.remove(pid).is_some() {
        let text = format!("{}\n", serde_json::to_string_pretty(&Value::Object(auth)).unwrap_or_default());
        crate::sys::write_atomic(std::path::Path::new(&k.file), text.as_bytes()).await.map_err(|e| WireError::invalid(e.to_string()))?;
    }
    view(agent, k).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use wisp_runtime_api::harness::KeyProvider;

    #[tokio::test]
    async fn a_key_goes_where_the_cli_keeps_it_and_the_others_stay() {
        let dir = std::env::temp_dir().join(format!("wisp-keys-{}", std::process::id()));
        let file = dir.join("opencode/auth.json");
        tokio::fs::create_dir_all(file.parent().unwrap_or(&dir)).await.unwrap_or_default();
        tokio::fs::write(&file, r#"{"anthropic":{"type":"oauth"}}"#).await.unwrap_or_default();
        let k = HarnessKeys {
            env: "WISP_TEST_NO_SUCH_KEY".into(),
            url: "https://opencode.ai/auth".into(),
            providers: vec![KeyProvider { id: "opencode".into(), name: "Zen".into() }],
            file: file.to_string_lossy().into_owned(),
        };
        let v = set("opencode", &k, "opencode", " sk-123 ").await.unwrap_or_else(|e| panic!("{e:?}"));
        assert!(v.providers[0].set);
        let saved: Value = serde_json::from_str(&tokio::fs::read_to_string(&file).await.unwrap_or_default()).unwrap_or_default();
        assert_eq!((saved["opencode"]["key"].as_str(), saved["anthropic"]["type"].as_str()), (Some("sk-123"), Some("oauth")));
        assert!(set("opencode", &k, "opencode", "has space").await.is_err());
        assert!(set("opencode", &k, "nope", "k").await.is_err());
        assert!(!remove("opencode", &k, "opencode").await.unwrap_or_else(|e| panic!("{e:?}")).providers[0].set);
        tokio::fs::write(&file, "not json").await.unwrap_or_default();
        assert!(set("opencode", &k, "opencode", "k").await.is_err(), "an unreadable file is never overwritten");
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}
