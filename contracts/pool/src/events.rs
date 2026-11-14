//! NEP-297 events, standard `krater`.
//!
//! Every variant carries its own version, which the event macro requires. Amounts
//! are `U128` so the JSON form is a decimal string. `amount_out_gross` on `Swap`
//! is the amount the pool transfers out before the output token's own transfer
//! behaviour applies, which is why it is not called `sent` or `received`.
//!
//! Credits live in a non-iterable map, so `CreditAdded`, `CreditSpent` and
//! `CreditWithdrawn` are the only way an indexer can follow them.

use near_sdk::json_types::U128;
use near_sdk::{AccountId, near};

/// Everything the pool emits.
#[near(event_json(standard = "krater"))]
#[derive(Debug, Clone)]
pub enum PoolEvent {
    /// A swap filled: input taken from `sender`, output transferred to `sender`.
    #[event_version("1.0.0")]
    Swap {
        sender: AccountId,
        token_in: AccountId,
        amount_in: U128,
        amount_out_gross: U128,
    },
    /// Liquidity added from credits, minting `shares`.
    #[event_version("1.0.0")]
    Deposit {
        who: AccountId,
        amount_a: U128,
        amount_b: U128,
        shares: U128,
    },
    /// Shares burned and both payout legs attempted.
    #[event_version("1.0.0")]
    Withdraw {
        who: AccountId,
        amount_a: U128,
        amount_b: U128,
        shares: U128,
    },
    /// The cached reserves and token indices after a successful sync.
    #[event_version("1.0.0")]
    ReservesSynced {
        reserve_a: U128,
        reserve_b: U128,
        index_a: U128,
        index_b: U128,
    },
    /// A deposit credited to `account_id` in `token`.
    #[event_version("1.0.0")]
    CreditAdded {
        account_id: AccountId,
        token: AccountId,
        amount: U128,
    },
    /// Credits consumed by `add_liquidity`.
    #[event_version("1.0.0")]
    CreditSpent {
        account_id: AccountId,
        token: AccountId,
        amount: U128,
    },
    /// Credits paid out through `withdraw_deposit`.
    #[event_version("1.0.0")]
    CreditWithdrawn {
        account_id: AccountId,
        token: AccountId,
        amount: U128,
    },
    /// An `add_liquidity` call that was accepted but could not mint.
    #[event_version("1.0.0")]
    AddLiquidityFailed {
        account_id: AccountId,
        reason: String,
    },
}
