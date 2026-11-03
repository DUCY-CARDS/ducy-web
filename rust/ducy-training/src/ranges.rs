//! Hold'em range text as the study pages read it (ducy-web #464): ducy's
//! notation (`QQ+, AKs, A5s-A2s, KQo, AhKh`) plus "top N%", the trainer's
//! ranking cut at N. Bad terms are skipped and named, so a range being typed
//! keeps showing what's readable so far.

use ducy::deck::Deck;
use ducy::games::holdem::HoldemRange;

use crate::holdem_rank::HOLDEM_PERCENTILE;

/// What range text covers: its hand classes ("AA", "AKs", "AKo") and a
/// message for each term that isn't a hand or range.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
pub struct RangeRead {
    /// Every class covered, "top N%" classes first, then ducy's in grid order.
    pub classes: Vec<String>,
    /// ducy's message for each bad term, in order.
    pub errors: Vec<String>,
}

/// The top `pct`% of Hold'em hands by the trainer's ranking: every class
/// whose middle combo falls inside the cutoff, so the range covers about
/// `pct`% of the 1,326 combos. Best first.
pub fn top_range(pct: f64) -> Vec<&'static str> {
    HOLDEM_PERCENTILE
        .iter()
        .filter(|(_, p)| *p < pct)
        .map(|(c, _)| *c)
        .collect()
}

/// Reads range text like "QQ+, AKs, A5s-A2s, KQ, top 20%".
pub fn read_holdem_range(text: &str) -> RangeRead {
    let mut read = RangeRead::default();
    fn add(c: &str, classes: &mut Vec<String>) {
        if !classes.iter().any(|x| x == c) {
            classes.push(c.to_string());
        }
    }
    let (mut text, tops) = take_tops(text);
    for pct in tops {
        for c in top_range(pct) {
            add(c, &mut read.classes);
        }
    }
    // Each bad term ducy names is blanked out and the rest read again.
    for _ in 0..100 {
        match HoldemRange::report(&text, Deck::empty()) {
            Ok(r) => {
                for c in &r.classes {
                    add(c, &mut read.classes);
                }
                break;
            }
            Err(e) => {
                read.errors.push(e.message);
                let end = e.start + e.term.len();
                text.replace_range(e.start..end, &" ".repeat(e.term.len()));
            }
        }
    }
    read
}

/// Takes each "top 20%" (also "top20", "TOP 12.5 %") out of `text`, leaving
/// a space, and returns what's left with the percentages.
fn take_tops(text: &str) -> (String, Vec<f64>) {
    let b = text.as_bytes();
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let (mut out, mut tops) = (String::new(), Vec::new());
    let (mut i, mut kept) = (0, 0);
    while i + 3 <= b.len() {
        let at_word = i == 0 || !word(b[i - 1]);
        if !at_word || !b[i..i + 3].eq_ignore_ascii_case(b"top") {
            i += 1;
            continue;
        }
        let space = |mut j: usize| {
            while j < b.len() && b[j].is_ascii_whitespace() {
                j += 1;
            }
            j
        };
        let digits = |mut j: usize| {
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            j
        };
        let n = space(i + 3);
        let mut j = digits(n);
        if j == n {
            i += 1;
            continue;
        }
        if j + 1 < b.len() && b[j] == b'.' && b[j + 1].is_ascii_digit() {
            j = digits(j + 1);
        }
        let pct: f64 = text[n..j].parse().unwrap_or(0.0);
        let mut end = space(j);
        if end < b.len() && b[end] == b'%' {
            end += 1;
        }
        tops.push(pct);
        out.push_str(&text[kept..i]);
        out.push(' ');
        kept = end;
        i = end;
    }
    out.push_str(&text[kept..]);
    (out, tops)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn top_percent_cuts_the_ranking() {
        assert_eq!(top_range(1.0), ["AA", "KK"]);
        assert_eq!(top_range(100.0).len(), 169);
        assert!(top_range(0.0).is_empty());
    }

    #[test]
    fn reads_tops_and_hands() {
        let r = read_holdem_range("top 1%, AKs");
        assert_eq!(r.classes, ["AA", "KK", "AKs"]);
        assert!(r.errors.is_empty());
        assert_eq!(read_holdem_range("TOP1").classes, ["AA", "KK"]);
        assert_eq!(read_holdem_range("top 1.2 %").classes, ["AA", "KK", "QQ"]);
        // Only a whole word: "stop 5%" isn't a top.
        assert!(!read_holdem_range("stop 5%").errors.is_empty());
    }

    #[test]
    fn names_every_bad_term_and_keeps_the_rest() {
        let r = read_holdem_range("QQ+, AKx, top, KQs, ✓");
        assert_eq!(r.classes, ["AA", "KK", "KQs", "QQ"]);
        assert_eq!(r.errors.len(), 3);
        assert!(r.errors[0].contains("AKx"));
        assert!(r.errors[1].contains("top"));
        assert!(r.errors[2].contains('✓'));
        assert_eq!(read_holdem_range("AKs, 🂡").errors.len(), 1);
        assert_eq!(read_holdem_range("🂡").errors.len(), 1);
    }

    #[test]
    fn take_tops_leaves_a_space() {
        assert_eq!(take_tops("AA,top 5%,KK"), ("AA, ,KK".into(), vec![5.0]));
        assert_eq!(take_tops("top 5 x"), (" x".into(), vec![5.0]));
        assert_eq!(take_tops("top"), ("top".into(), vec![]));
    }
}
