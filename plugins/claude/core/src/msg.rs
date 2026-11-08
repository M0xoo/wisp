//! An assistant or user `message`, read without building it: its content parts are typed views over
//! the line's own bytes, and each field is decoded only when the parser asks for it. Most of a long
//! run's bytes are tool results and prose, which this copies once, into the event that carries them.

use std::borrow::Cow;

use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;
use wisp_harness_kit::js;

/// `T` when the JSON is an object, `T::default()` for anything else: v1 read untrusted JSON field by
/// field (`rec(msg.message)`), so a message or part of the wrong shape must not lose the whole line.
#[derive(Debug, Default)]
pub struct Lenient<T>(pub T);

impl<'de, T: Deserialize<'de> + Default> Deserialize<'de> for Lenient<T> {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V<T>(std::marker::PhantomData<T>);
        impl<'de, T: Deserialize<'de> + Default> serde::de::Visitor<'de> for V<T> {
            type Value = Lenient<T>;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                map: A,
            ) -> Result<Lenient<T>, A::Error> {
                T::deserialize(serde::de::value::MapAccessDeserializer::new(map)).map(Lenient)
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<Lenient<T>, A::Error> {
                while seq.next_element::<serde::de::IgnoredAny>()?.is_some() {}
                Ok(Lenient(T::default()))
            }
            fn visit_bool<E>(self, _: bool) -> Result<Lenient<T>, E> {
                Ok(Lenient(T::default()))
            }
            fn visit_i64<E>(self, _: i64) -> Result<Lenient<T>, E> {
                Ok(Lenient(T::default()))
            }
            fn visit_u64<E>(self, _: u64) -> Result<Lenient<T>, E> {
                Ok(Lenient(T::default()))
            }
            fn visit_f64<E>(self, _: f64) -> Result<Lenient<T>, E> {
                Ok(Lenient(T::default()))
            }
            fn visit_str<E>(self, _: &str) -> Result<Lenient<T>, E> {
                Ok(Lenient(T::default()))
            }
            fn visit_unit<E>(self) -> Result<Lenient<T>, E> {
                Ok(Lenient(T::default()))
            }
        }
        d.deserialize_any(V(std::marker::PhantomData))
    }
}

/// `message`: the keys the parser reads.
#[derive(Debug, Default, Deserialize)]
pub struct Msg<'a> {
    #[serde(borrow, default)]
    pub content: Content<'a>,
    /// None: missing (or null)
    #[serde(borrow, default)]
    pub usage: Option<Lenient<Usage<'a>>>,
    #[serde(borrow, default)]
    pub stop_reason: Option<&'a RawValue>,
    #[serde(borrow, default)]
    pub model: Option<&'a RawValue>,
    #[serde(borrow, default)]
    pub id: Option<&'a RawValue>,
}

/// A message's `content`, read in the same pass as the message: a list of parts (anything that isn't
/// an object reads as a part with no fields, as v1's `rec(p)` did), or a plain string.
#[derive(Debug, Default)]
pub struct Content<'a> {
    pub parts: Vec<Part<'a>>,
    pub text: Option<Cow<'a, str>>,
}

impl<'de: 'a, 'a> Deserialize<'de> for Content<'a> {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V<'a>(std::marker::PhantomData<&'a ()>);
        impl<'de: 'a, 'a> serde::de::Visitor<'de> for V<'a> {
            type Value = Content<'a>;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<Content<'a>, A::Error> {
                let mut parts = Vec::new();
                while let Some(Lenient(p)) = seq.next_element::<Lenient<Part<'a>>>()? {
                    parts.push(p);
                }
                Ok(Content { parts, text: None })
            }
            fn visit_borrowed_str<E>(self, s: &'de str) -> Result<Content<'a>, E> {
                Ok(Content {
                    parts: Vec::new(),
                    text: Some(Cow::Borrowed(s)),
                })
            }
            fn visit_str<E>(self, s: &str) -> Result<Content<'a>, E> {
                Ok(Content {
                    parts: Vec::new(),
                    text: Some(Cow::Owned(s.to_owned())),
                })
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Content<'a>, A::Error> {
                while map
                    .next_entry::<serde::de::IgnoredAny, serde::de::IgnoredAny>()?
                    .is_some()
                {}
                Ok(Content::default())
            }
            fn visit_bool<E>(self, _: bool) -> Result<Content<'a>, E> {
                Ok(Content::default())
            }
            fn visit_i64<E>(self, _: i64) -> Result<Content<'a>, E> {
                Ok(Content::default())
            }
            fn visit_u64<E>(self, _: u64) -> Result<Content<'a>, E> {
                Ok(Content::default())
            }
            fn visit_f64<E>(self, _: f64) -> Result<Content<'a>, E> {
                Ok(Content::default())
            }
            fn visit_unit<E>(self) -> Result<Content<'a>, E> {
                Ok(Content::default())
            }
        }
        d.deserialize_any(V(std::marker::PhantomData))
    }
}

impl Content<'_> {
    /// v1 `flatten(content)`: a string as is, a list's parts' texts joined by newlines.
    pub fn flatten(&self) -> String {
        if let Some(t) = &self.text {
            return t.clone().into_owned();
        }
        let mut out = String::new();
        for (i, p) in self.parts.iter().enumerate() {
            if i > 0 {
                out.push('\n');
            }
            if truthy(p.text) {
                out.push_str(&text(p.text));
            }
        }
        out
    }
}

/// A message's `usage`: one request's token counts, read as numbers only when asked.
#[derive(Debug, Default, Deserialize)]
pub struct Usage<'a> {
    #[serde(borrow, default)]
    pub input_tokens: Option<&'a RawValue>,
    #[serde(borrow, default)]
    pub output_tokens: Option<&'a RawValue>,
    #[serde(borrow, default)]
    pub cache_read_input_tokens: Option<&'a RawValue>,
    #[serde(borrow, default)]
    pub cache_creation_input_tokens: Option<&'a RawValue>,
    #[serde(borrow, default)]
    pub cache_creation: Lenient<CacheCreation<'a>>,
}

/// `usage.cache_creation`: which cache TTL the provider wrote with.
#[derive(Debug, Default, Deserialize)]
pub struct CacheCreation<'a> {
    #[serde(borrow, default)]
    pub ephemeral_1h_input_tokens: Option<&'a RawValue>,
    #[serde(borrow, default)]
    pub ephemeral_5m_input_tokens: Option<&'a RawValue>,
}

/// One content part (text, thinking, tool_use, tool_result). Every field is raw, so a part of any
/// shape reads: v1 looked at each field on its own.
#[derive(Debug, Default, Deserialize)]
pub struct Part<'a> {
    #[serde(rename = "type", borrow, default)]
    pub ty: Option<&'a RawValue>,
    #[serde(borrow, default)]
    pub text: Option<&'a RawValue>,
    #[serde(borrow, default)]
    pub thinking: Option<&'a RawValue>,
    #[serde(borrow, default)]
    pub id: Option<&'a RawValue>,
    #[serde(borrow, default)]
    pub name: Option<&'a RawValue>,
    #[serde(borrow, default)]
    pub input: Option<&'a RawValue>,
    #[serde(borrow, default)]
    pub tool_use_id: Option<&'a RawValue>,
    #[serde(borrow, default)]
    pub is_error: Option<&'a RawValue>,
    #[serde(borrow, default)]
    pub content: Option<&'a RawValue>,
}

/// A raw field as `Value` (None: missing, which v1 read as undefined).
pub fn value(raw: Option<&RawValue>) -> Value {
    raw.and_then(|r| serde_json::from_str(r.get()).ok())
        .unwrap_or(Value::Null)
}

/// The reference port's `str(v)` over a raw field, borrowed when it is a plain JSON string.
pub fn text<'a>(raw: Option<&'a RawValue>) -> Cow<'a, str> {
    let Some(r) = raw else {
        return Cow::Borrowed("");
    };
    if r.get().starts_with('"') {
        if let Ok(s) = serde_json::from_str::<Cow<'a, str>>(r.get()) {
            return s;
        }
    }
    Cow::Owned(js::str(&value(Some(r))))
}

/// Whether a raw field is the JSON string `want`.
pub fn is(raw: Option<&RawValue>, want: &str) -> bool {
    raw.is_some_and(|r| r.get().starts_with('"')) && text(raw) == want
}

/// JavaScript truthiness of a raw field, without decoding a string or an object.
pub fn truthy(raw: Option<&RawValue>) -> bool {
    match raw.map(RawValue::get) {
        None | Some("null" | "false" | "\"\"") => false,
        Some(s)
            if s.starts_with('"') || s.starts_with('[') || s.starts_with('{') || s == "true" =>
        {
            true
        }
        Some(_) => js::truthy(&value(raw)),
    }
}

/// A part's `{text}` list: the one field `flatten` reads.
#[derive(Deserialize)]
struct TextPart<'a> {
    #[serde(borrow, default)]
    text: Option<&'a RawValue>,
}

/// v1 `flatten(content)` over a raw field: a string as is, a list's parts' texts joined by newlines.
pub fn flatten(raw: Option<&RawValue>) -> String {
    let Some(r) = raw else { return String::new() };
    match r.get().as_bytes().first() {
        Some(b'"') => text(Some(r)).into_owned(),
        Some(b'[') => {
            let items: Vec<&RawValue> = serde_json::from_str(r.get()).unwrap_or_default();
            let mut out = String::new();
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push('\n');
                }
                // `c.text || ''` on an object; a non-object part has no text
                if let Ok(p) = serde_json::from_str::<TextPart>(item.get())
                    && truthy(p.text)
                {
                    out.push_str(&text(p.text));
                }
            }
            out
        }
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(s: &str) -> Option<Box<RawValue>> {
        RawValue::from_string(s.to_owned()).ok()
    }

    #[test]
    fn reads_like_the_value_helpers() {
        for s in [
            r#""a\nb""#,
            "[1,{\"text\":\"x\"},{\"text\":\"\"},\"s\",{\"text\":7}]",
            "3",
            "null",
            "{}",
        ] {
            let Some(r) = raw(s) else { continue };
            let v: Value = serde_json::from_str(s).unwrap_or_default();
            assert_eq!(flatten(Some(&r)), wisp_harness_kit::flatten(&v), "{s}");
            assert_eq!(truthy(Some(&r)), js::truthy(&v), "{s}");
            assert_eq!(text(Some(&r)), js::str(&v), "{s}");
        }
        for s in ["0", "0.0", "1", "-0", "\"0\"", "[]", "true"] {
            let v: Value = serde_json::from_str(s).unwrap_or_default();
            assert_eq!(
                raw(s).as_deref().map(|r| truthy(Some(r))),
                Some(js::truthy(&v)),
                "{s}"
            );
        }
    }
}
