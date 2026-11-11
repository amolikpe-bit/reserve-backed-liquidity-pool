//! The `ft_transfer_call` message vocabulary.
//!
//! Settlement enters the pool through NEP-141: a token holder calls
//! `ft_transfer_call` on a pair token, the token calls `ft_on_transfer` here, and
//! the pool reads the amount the token reports as received. Parsing lives in this
//! module so the receiver and the tests agree on one shape.
//!
//! - `""` or `{"Deposit":{}}` credits the sender's balance for that token.
//! - `{"Swap":{"min_out":"<amount>"}}` asks for an exact-input swap.
//!
//! Anything else is rejected by returning the whole amount unused, so a caller
//! cannot make the pool hold funds it does not account for.

use near_sdk::json_types::U128;
use near_sdk::{near, serde_json};

/// The message accepted by `ft_on_transfer`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub enum PoolMsg {
    /// Exact-input swap: `min_out` is the least output the sender will accept.
    Swap { min_out: U128 },
    /// Credit the transferred amount to the sender, to be added later.
    Deposit {},
}

/// Parse an `ft_transfer_call` message. An empty message means `Deposit`.
///
/// Returns `None` for a malformed or unknown message; the receiver refunds the
/// transfer in that case.
pub fn parse_msg(msg: &str) -> Option<PoolMsg> {
    if msg.trim().is_empty() {
        return Some(PoolMsg::Deposit {});
    }
    serde_json::from_str(msg).ok()
}
