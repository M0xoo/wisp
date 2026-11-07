//! The `t` of each message: a unit type that writes its name and reads only that name, so a
//! `Welcome` can't be decoded from a `{"t":"patch"}` and TypeScript sees the literal (`t: 'welcome'`).

macro_rules! tags {
    ($($name:ident = $lit:literal),* $(,)?) => {$(
        #[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
        pub struct $name;

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str($lit)
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let s = <std::borrow::Cow<'de, str>>::deserialize(d)?;
                if s == $lit { Ok(Self) } else { Err(<D::Error as serde::de::Error>::custom(concat!("expected t = ", $lit))) }
            }
        }
    )*};
}

tags! {
    Hello = "hello",
    Sub = "sub",
    Unsub = "unsub",
    Window = "window",
    Mutate = "mutate",
    Welcome = "welcome",
    Snapshot = "snapshot",
    Patch = "patch",
    Rows = "rows",
    Ack = "ack",
    Reject = "reject",
    Resync = "resync",
    Notice = "notice",
}
