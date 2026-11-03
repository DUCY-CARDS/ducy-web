//! Chat at a friends table (ducy-host's `chat`, ducy-web #462), for
//! table-chat.js: what someone typed made into one short line, the name on
//! it, a chat message from the host read, and the host's flood control.

use ducy_host::chat::{self, Limiter};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

use crate::util::{err, to_js};

/// What someone typed, ready to send: one line of at most 200 characters,
/// or '' if nothing's left.
#[wasm_bindgen(js_name = chatClean)]
pub fn chat_clean(text: &str) -> String {
    chat::clean(text)
}

/// The name on a chat line: what the player calls themselves, cut short,
/// or "A player".
#[wasm_bindgen(js_name = chatName)]
pub fn chat_name(text: &str) -> String {
    chat::name(text)
}

/// A value as text the way a page writes it, or none for an object or list.
fn text(v: &Value) -> Option<String> {
    Some(match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    })
}

/// A chat message from the host as a guest receives it: {from, text, at},
/// or null if it isn't one (`at` is `now` if it has none).
#[wasm_bindgen(js_name = chatRead)]
pub fn chat_read(m: JsValue, now: f64) -> Result<JsValue, JsError> {
    let m: Value = serde_wasm_bindgen::from_value(m).map_err(err)?;
    if m["type"] != "chat" {
        return Ok(JsValue::NULL);
    }
    let (Some(body), Some(from)) = (text(&m["text"]), text(&m["from"])) else {
        return Ok(JsValue::NULL);
    };
    let body = chat::clean(&body);
    if body.is_empty() {
        return Ok(JsValue::NULL);
    }
    let at = m["at"].as_f64().unwrap_or(now);
    to_js(&json!({"from": chat::name(&from), "text": body, "at": at}))
}

/// The host's flood control: at most `burst` messages from one person in
/// any `windowMs` (5 in 10 seconds unless given).
#[wasm_bindgen]
pub struct ChatLimiter(Limiter);

#[wasm_bindgen]
impl ChatLimiter {
    #[wasm_bindgen(constructor)]
    pub fn new(burst: Option<u32>, window_ms: Option<f64>) -> ChatLimiter {
        ChatLimiter(Limiter::new(
            burst.map_or(chat::CHAT_BURST, |b| b as usize),
            window_ms.map_or(chat::CHAT_WINDOW_MS, |w| w as u64),
        ))
    }

    /// Whether `who` may send another message at `now`; if so, it counts.
    pub fn allow(&mut self, who: &str, now: f64) -> bool {
        self.0.allow(who, now as u64)
    }
}
