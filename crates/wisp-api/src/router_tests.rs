use super::*;

fn spec(method: &str, pattern: &str) -> Spec {
    Spec {
        method: method.into(),
        pattern: pattern.into(),
        raw: false,
        permission: "x:y".into(),
        doc: true,
        summary: "s".into(),
        max_body: None,
        owner: "t".into(),
    }
}
fn table(routes: &[(&str, &str)]) -> Table {
    let mut t = Table::new();
    for (m, p) in routes {
        t.add(spec(m, p), Target::Own(Own::Health)).unwrap();
    }
    t
}

#[test]
fn whole_segments_only() {
    let t = table(&[("GET", "/sessions/:id"), ("GET", "/sessions")]);
    assert_eq!(t.find("GET", "/api/sessions/abc").unwrap().1["id"], "abc");
    assert_eq!(t.find("GET", "/api/sessions").unwrap().0.path, "/api/sessions");
    assert!(t.find("GET", "/api/sessionsX").is_none());
    assert!(t.find("GET", "/api/sessions/abc/more").is_none());
    assert!(t.find("GET", "/apix/sessions").is_none());
    // trailing and doubled slashes are the same segments, as in v1
    assert!(t.find("GET", "/api//sessions/").is_some());
}

#[test]
fn literals_first_then_first_added() {
    for order in [[("GET", "/projects/discover"), ("GET", "/projects/:id")], [("GET", "/projects/:id"), ("GET", "/projects/discover")]] {
        let t = table(&order);
        assert!(t.find("GET", "/api/projects/discover").unwrap().1.is_empty());
        assert_eq!(t.find("GET", "/api/projects/p1").unwrap().1["id"], "p1");
    }
    let mut t = Table::new();
    t.add(Spec { owner: "a".into(), ..spec("GET", "/x/:id") }, Target::Own(Own::Health)).unwrap();
    t.add(Spec { owner: "b".into(), ..spec("GET", "/x/:name") }, Target::Own(Own::Health)).unwrap();
    assert_eq!(t.find("GET", "/api/x/1").unwrap().0.owner, "a");
}

#[test]
fn rest_segments() {
    let mut t = Table::new();
    t.add(Spec { raw: true, ..spec("GET", "/p/*") }, Target::Own(Own::Health)).unwrap();
    t.add(Spec { raw: true, ..spec("GET", "/p/exact") }, Target::Own(Own::Health)).unwrap();
    assert_eq!(t.find("GET", "/p/a/b%20c/d").unwrap().1["*"], "a/b c/d");
    assert_eq!(t.find("GET", "/p/exact").unwrap().0.path, "/p/exact");
    assert!(t.find("GET", "/p").is_none());
    assert!(t.add(spec("GET", "/a/*/b"), Target::Own(Own::Health)).is_err());
}

#[test]
fn captures_are_decoded_and_malformed_ones_match_nothing() {
    let t = table(&[("GET", "/crew/:id")]);
    assert_eq!(t.find("GET", "/api/crew/%40ada%20lovelace").unwrap().1["id"], "@ada lovelace");
    assert_eq!(t.find("GET", "/api/crew/%E2%9C%93").unwrap().1["id"], "✓");
    assert!(t.find("GET", "/api/crew/%E2%9C").is_none());
    assert!(t.find("GET", "/api/crew/%zz").is_none());
    assert!(t.find("GET", "/api/crew/%4").is_none());
}

#[test]
fn methods_and_head() {
    let t = table(&[("GET", "/x"), ("POST", "/y")]);
    assert!(t.find("POST", "/api/x").is_none());
    assert!(t.find("HEAD", "/api/x").is_some());
    assert!(t.find("HEAD", "/api/y").is_none());
}

#[test]
fn raw_routes_and_default_deny() {
    let mut t = Table::new();
    t.add(Spec { raw: true, ..spec("POST", "/hooks/:id") }, Target::Own(Own::Health)).unwrap();
    assert!(t.find("POST", "/hooks/h1").is_some());
    assert!(t.add(Spec { permission: String::new(), ..spec("GET", "/z") }, Target::Own(Own::Health)).is_err());
    assert!(t.add(spec("GET", "nope"), Target::Own(Own::Health)).is_err());
}

#[test]
fn many_routes_stay_cheap() {
    let mut t = Table::new();
    for i in 0..300 {
        t.add(spec("GET", &format!("/area{i}/:id")), Target::Own(Own::Health)).unwrap();
    }
    let started = std::time::Instant::now();
    for _ in 0..10_000 {
        assert!(t.find("GET", "/api/area299/x").is_some());
    }
    // a linear scan of one bucket (300 two-segment GETs): far under a microsecond per lookup in release
    assert!(started.elapsed().as_millis() < 2_000);
}
