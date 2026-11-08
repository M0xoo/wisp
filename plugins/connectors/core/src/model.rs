//! The connector model's checks that need the user's secrets (v1 routes/connectors.js `missing`).
//! The secret store isn't read here: `has("env:KEY")` / `has("header:Name")` answers whether a value
//! is set, so this stays sans-IO.

use wisp_connectors_api::Connector;

/// The secret slots a connector declares, in v1's order: its env keys, then its headers, each as
/// `env:KEY` or `header:Name`.
pub fn slots(x: &Connector) -> Vec<String> {
    x.env.iter().map(|k| format!("env:{k}")).chain(x.headers.iter().map(|k| format!("header:{k}"))).collect()
}

/// The slots the user hasn't filled in yet.
pub fn missing(x: &Connector, has: &dyn Fn(&str) -> bool) -> Vec<String> {
    slots(x).into_iter().filter(|k| !has(k)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_then_headers_and_only_the_unset_ones() {
        let x = Connector { env: vec!["TOKEN".into(), "ORG".into()], headers: vec!["Authorization".into()], ..Connector::default() };
        assert_eq!(slots(&x), ["env:TOKEN", "env:ORG", "header:Authorization"]);
        assert_eq!(missing(&x, &|k| k == "env:ORG"), ["env:TOKEN", "header:Authorization"]);
        assert_eq!(missing(&x, &|_| true), [] as [std::string::String; 0]);
    }
}
