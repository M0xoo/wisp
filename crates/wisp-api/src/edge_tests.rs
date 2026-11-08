use super::*;

#[test]
fn queries_decode_like_url_search_params() {
    assert_eq!(
        parse_query(Some("a=1&b=x+y&c=%E2%9C%93&flag&d=%zz")),
        vec![
            ("a".into(), "1".into()),
            ("b".into(), "x y".into()),
            ("c".into(), "✓".into()),
            ("flag".into(), String::new()),
            ("d".into(), "%zz".into())
        ]
    );
    assert_eq!(
        parse_query(None),
        [] as [(std::string::String, std::string::String); 0]
    );
}

#[test]
fn json_bodies() {
    let mut h = HeaderMap::new();
    h.insert("content-type", "application/json".parse().unwrap());
    assert_eq!(
        json_body(&h, Bytes::new()).unwrap(),
        Bytes::from_static(b"{}")
    );
    assert!(matches!(
        json_body(&h, Bytes::from_static(b"{nope")),
        Err(ApiError::InvalidJson)
    ));
    assert!(json_body(&h, Bytes::from_static("{\"t\":\"✓\"}".as_bytes())).is_ok());
    assert!(matches!(
        json_body(&h, Bytes::from_static(b"\xff\xfe")),
        Err(ApiError::InvalidJson)
    ));
    h.insert("content-type", "application/octet-stream".parse().unwrap());
    assert_eq!(
        json_body(&h, Bytes::from_static(b"\xff")).unwrap(),
        Bytes::from_static(b"\xff")
    );
}
