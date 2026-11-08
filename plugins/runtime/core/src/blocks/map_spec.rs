//! The `map` block (v1 `web/js/map-spec.js`): places the agent names (addresses, or coordinates), shown
//! on a Google map with a link that opens each in Google Maps. The page and the text stand-in share it.

use serde_json::{Map, Value};

use super::js;

pub const MAX_PLACES: usize = 20;
/// Google's directions links take an origin, a destination and 8 stops between.
pub const ROUTE_MAX: usize = 10;
const Q_MAX: usize = 300;

#[derive(Debug, Clone, PartialEq)]
pub struct Place {
    pub name: String,
    pub address: String,
    pub note: String,
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    /// what Google is asked for: the coordinates, else the address, else the name (≤ 300 UTF-16 units)
    pub q: String,
    /// the 300-unit cut fell inside a surrogate pair: v1 kept half a character, and its links threw
    pub torn: bool,
}

/// map-spec's `str`: strings and numbers, whitespace runs collapsed, trimmed; anything else is ''.
fn text(v: Option<&Value>) -> String {
    let s = match v {
        Some(Value::String(s)) => s.clone(),
        Some(n @ Value::Number(_)) => js::string(n),
        _ => return String::new(),
    };
    let mut out = String::with_capacity(s.len());
    let mut gap = false;
    for c in s.chars() {
        if js::is_ws(c) {
            gap = true;
        } else {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.push(c);
        }
    }
    out
}

/// map-spec's `num`: null for '', null, undefined and NaN, else `Number(v)`.
fn num(v: Option<&Value>) -> Option<f64> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        v => Some(js::to_number(v)).filter(|x| !x.is_nan()),
    }
}

fn num_str(s: Option<&str>) -> Option<f64> {
    match s {
        None | Some("") => None,
        Some(s) => Some(js::str_to_number(s)).filter(|x| !x.is_nan()),
    }
}

// lat/lng, lat/lon, latitude/longitude, or [lat, lng] / "lat,lng" in `coords` (or `location`).
fn lng_of(o: &Map<String, Value>) -> Option<&Value> {
    js::nullish(js::nullish(o.get("lng"), o.get("lon")), o.get("longitude"))
}

fn coords(p: &Map<String, Value>) -> Option<(f64, f64)> {
    let (lat, lng) = match js::nullish(p.get("coords"), p.get("location")) {
        Some(Value::String(s)) => {
            let mut parts = s.split(',');
            (num_str(parts.next()), num_str(parts.next()))
        }
        Some(Value::Object(o)) => (
            num(js::nullish(o.get("lat"), o.get("latitude"))),
            num(lng_of(o)),
        ),
        Some(Value::Array(a)) => (num(a.first()), num(a.get(1))),
        _ => (
            num(js::nullish(p.get("lat"), p.get("latitude"))),
            num(lng_of(p)),
        ),
    };
    let (lat, lng) = (lat?, lng?);
    (lat.abs() <= 90.0 && lng.abs() <= 180.0).then_some((lat, lng))
}

/// The places in a block. Accepts `places` (objects or plain address strings), `addresses`, or one
/// `address` / `query` (or coordinates) on the block itself. A place with nothing to search for is left out.
pub fn map_places(b: &Map<String, Value>) -> Vec<Place> {
    let one = [Value::Null];
    let (raw, whole): (&[Value], bool) = match (b.get("places"), b.get("addresses")) {
        (Some(Value::Array(a)), _) | (_, Some(Value::Array(a))) => (a, false),
        _ if js::truthy(b.get("address")) || js::truthy(b.get("query")) || coords(b).is_some() => {
            (&one, true)
        }
        _ => (&[], false),
    };
    let mut out = Vec::new();
    for p in raw {
        if out.len() >= MAX_PLACES {
            break;
        }
        let wrapped;
        let o: &Map<String, Value> = match p {
            _ if whole => b,
            Value::String(s) => {
                wrapped = Map::from_iter([("address".to_owned(), Value::String(s.clone()))]);
                &wrapped
            }
            Value::Object(o) => o,
            _ => continue,
        };
        let own = |k: &'static str| if whole { None } else { o.get(k) };
        let address = text(js::nullish(
            js::nullish(o.get("address"), o.get("query")),
            own("q"),
        ));
        let name = text(js::nullish(
            js::nullish(o.get("name"), o.get("label")),
            own("title"),
        ));
        let note = text(js::nullish(
            js::nullish(o.get("note"), o.get("detail")),
            own("caption"),
        ));
        let at = coords(o);
        let q = match at {
            Some((lat, lng)) => format!("{},{}", js::number(lat), js::number(lng)),
            None if !address.is_empty() => address.clone(),
            None => name.clone(),
        };
        if q.is_empty() {
            continue;
        }
        let (cut, torn) = js::slice_utf16(&q, Q_MAX);
        out.push(Place {
            name,
            address,
            note,
            lat: at.map(|c| c.0),
            lng: at.map(|c| c.1),
            q: cut.to_owned(),
            torn,
        });
    }
    out
}

/// The map's zoom: the block's, rounded and kept within Google's 1–21, else 15.
pub fn map_zoom(b: &Map<String, Value>) -> u8 {
    let z = js::to_number(b.get("zoom"));
    if !z.is_finite() {
        return 15;
    }
    // Math.round: halves go up
    let z = if z - z.floor() >= 0.5 {
        z.ceil()
    } else {
        z.floor()
    };
    (1_u8..=21).find(|&k| f64::from(k) >= z).unwrap_or(21)
}

/// The map in the answer: Google's embed, which needs no API key.
pub fn embed_url(p: &Place, zoom: u8) -> String {
    format!(
        "https://maps.google.com/maps?q={}&z={zoom}&output=embed",
        js::encode_uri_component(&p.q)
    )
}

/// The place in Google Maps (the app on a phone): a search for its address, or a pin at its coordinates.
pub fn open_url(p: &Place) -> String {
    format!(
        "https://www.google.com/maps/search/?api=1&query={}",
        js::encode_uri_component(&p.q)
    )
}

/// Directions through the places in order, from the first to the last (at most [`ROUTE_MAX`]).
pub fn route_url(places: &[Place]) -> Option<String> {
    let ps = &places[..places.len().min(ROUTE_MAX)];
    let [first, mid @ .., last] = ps else {
        return None;
    };
    let enc = js::encode_uri_component;
    let mut url = format!(
        "https://www.google.com/maps/dir/?api=1&origin={}&destination={}",
        enc(&first.q),
        enc(&last.q)
    );
    if !mid.is_empty() {
        let joined: Vec<&str> = mid.iter().map(|p| p.q.as_str()).collect();
        url.push_str("&waypoints=");
        url.push_str(&enc(&joined.join("|")));
    }
    Some(url)
}
