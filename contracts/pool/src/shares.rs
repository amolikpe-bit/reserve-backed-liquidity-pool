//! Share and credit arithmetic.
//!
//! Two scales meet here:
//! - LP shares are the pool's NEP-141 supply; a share is worth
//!   `reserve / total_supply` of each token.
//! - Deposited credits are held as shares too, scaled by the depositing token's
//!   index (`nominal = shares * index / ONE`), so a rebase between deposit and
//!   `add_liquidity` does not change what the deposit is worth.
//!
//! Every product runs in `U256` and is narrowed once, with a named panic on
//! overflow. These helpers are pure: they take no state and emit nothing.

use near_sdk::env;
use primitive_types::U256;

use crate::pool::narrow;

/// Fixed-point one, and the index a fresh token starts at.
pub const ONE: u128 = 1_000_000_000_000_000_000;

/// Minimum liquidity permanently locked on the first deposit (minted to the pool
/// account itself), so the share supply can never be driven to zero.
pub const MINIMUM_SHARES: u128 = 1_000;

/// Nominal value of `credit_shares` at `index`: `shares * index / ONE`, rounded down.
///
/// A zero index yields zero rather than panicking: the sync callback stores ONE
/// when a token does not answer `ft_index`, and this helper is also used by views.
pub fn credit_nominal(credit_shares: u128, index: u128) -> u128 {
    narrow(U256::from(credit_shares) * U256::from(index) / U256::from(ONE))
}

/// Shares minted by the first deposit: `sqrt(amount_a * amount_b)`, rounded down.
pub fn initial_shares(amount_a: u128, amount_b: u128) -> u128 {
    narrow((U256::from(amount_a) * U256::from(amount_b)).integer_sqrt())
}

/// Shares minted by a later deposit, on one side: `amount * supply / reserve`,
/// rounded down. A zero reserve side is treated as unbounded, which is how the
/// min() over two sides ignores it.
pub fn proportional_shares(amount: u128, reserve: u128, supply: u128) -> u128 {
    if reserve == 0 {
        return u128::MAX;
    }
    narrow(U256::from(amount) * U256::from(supply) / U256::from(reserve))
}

/// Nominal value released by `shares` of the supply against `reserve`:
/// `shares * reserve / supply`, rounded down.
///
/// A zero reserve or supply has no ratio and yields zero, so a withdrawal from an
/// empty side pays nothing instead of dividing by zero.
pub fn proportional_amount(shares: u128, reserve: u128, supply: u128) -> u128 {
    if reserve == 0 || supply == 0 {
        return 0;
    }
    narrow(U256::from(shares) * U256::from(reserve) / U256::from(supply))
}

/// Nominal value `shares` of the supply must add to `reserve`:
/// `ceil(shares * reserve / supply)`.
///
/// Spending rounds up, so a mint never dilutes the pool by the depositor's own
/// rounding. A zero reserve or supply has no ratio and yields zero, which is how a
/// one-sided add spends nothing on the empty side.
pub fn proportional_amount_ceil(shares: u128, reserve: u128, supply: u128) -> u128 {
    if reserve == 0 || supply == 0 {
        return 0;
    }
    let numerator = U256::from(shares) * U256::from(reserve);
    if numerator == U256::zero() {
        return 0;
    }
    // `(n - 1) / d + 1` is `ceil(n / d)` and cannot overflow the way
    // `(n + d - 1) / d` can when both operands sit near `u128::MAX`.
    narrow((numerator - U256::from(1u128)) / U256::from(supply) + U256::from(1u128))
}

/// Credit shares for a nominal deposit: `amount * ONE / index`, rounded down.
///
/// # Panics
/// `InvalidIndex` if `index` is zero.
pub fn credit_shares(amount: u128, index: u128) -> u128 {
    if index == 0 {
        env::panic_str("InvalidIndex");
    }
    narrow(U256::from(amount) * U256::from(ONE) / U256::from(index))
}

/// Credit shares needed to cover a nominal `amount`: `ceil(amount * ONE / index)`.
///
/// Spending rounds up and crediting rounds down, so a credit can never be spent
/// for more nominal value than it was issued for.
///
/// # Panics
/// `InvalidIndex` if `index` is zero.
pub fn credit_shares_ceil(amount: u128, index: u128) -> u128 {
    if index == 0 {
        env::panic_str("InvalidIndex");
    }
    let index = U256::from(index);
    let scaled = U256::from(amount) * U256::from(ONE);
    narrow((scaled + index - U256::from(1u128)) / index)
}
