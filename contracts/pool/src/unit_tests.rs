//! Native unit vectors for the pure quote and share arithmetic.
//!
//! These exercise only success paths: the native test environment aborts on
//! `env::panic_str`, so panic branches (`NoReserves`, `MathOverflow`,
//! `InvalidIndex`) belong to the sandbox suite, which can catch a failed receipt.
//!
//! Sizes match the protocol: reserves and supplies at the 1e18–1e21 scale,
//! 30 bps fee, and products that overflow `u128` but not `U256`.

use crate::pool::quote_from_with_fee;
use crate::shares::{
    credit_nominal, credit_shares, credit_shares_ceil, initial_shares, proportional_shares,
    MINIMUM_SHARES, ONE,
};

const E18: u128 = 1_000_000_000_000_000_000;
const E21: u128 = 1_000_000_000_000_000_000_000;

/// 30 bps against a 1:2 pool at the low end of the base-unit scale:
/// `after_fee = 1_000 * 9_970`, `out = after_fee * 2_000_000 / (1_000_000 * 10_000 + after_fee)`.
#[test]
fn quote_reference_vector() {
    assert_eq!(quote_from_with_fee(1_000_000, 2_000_000, 1_000, 30), 1_992);
}

/// The same reserves with a ten-times larger input: 19_743, still exact integer
/// truncation of `99_700_000 * 2_000_000 / 10_099_700_000`.
#[test]
fn quote_larger_input_vector() {
    assert_eq!(quote_from_with_fee(1_000_000, 2_000_000, 10_000, 30), 19_743);
}

/// Zero input quotes zero; the fee can only reduce the output of a nonzero input.
#[test]
fn quote_zero_input_and_fee_ordering() {
    assert_eq!(quote_from_with_fee(1_000_000, 2_000_000, 0, 30), 0);

    let no_fee = quote_from_with_fee(1_000_000, 2_000_000, 10_000, 0);
    let with_fee = quote_from_with_fee(1_000_000, 2_000_000, 10_000, 30);
    assert!(no_fee > with_fee, "fee must not increase the quote");
}

/// 1e21-scale reserves keep `after_fee * r_out` (about 1e43) inside `U256`; the
/// narrowed result is a real `u128` and can never exceed the output reserve.
#[test]
fn quote_wide_intermediates_narrow_below_reserve_out() {
    let out = quote_from_with_fee(E21, E21, E18, 30);
    assert!(out > 0, "a funded pool must quote a nonzero output");
    assert!(out < E21, "a quote cannot exceed the output reserve");
}

/// A one-base-unit input in a one-base-unit pool truncates to zero rather than
/// rounding up; the caller sees `AmountTooSmall`-style dust, not a free trade.
#[test]
fn quote_tiny_input_truncates_to_zero() {
    assert_eq!(quote_from_with_fee(1, 1, 1, 0), 0);
}

/// First deposit: `sqrt(amount_a * amount_b)` at the 1e21 and 1e18 scales.
#[test]
fn initial_shares_vectors() {
    assert_eq!(initial_shares(E21, E21), E21);
    assert_eq!(initial_shares(E18, 4 * E18), 2 * E18);
}

/// Later deposits: `amount * supply / reserve`, and a zero reserve side is
/// unbounded so the `min()` over the two legs ignores it.
#[test]
fn proportional_shares_vectors() {
    assert_eq!(proportional_shares(E18, 2 * E21, E21), E18 / 2);
    assert_eq!(proportional_shares(123, 0, 456), u128::MAX);
}

/// Credit shares round down when issued and are recovered with `ceil` when
/// spent, so a credit can never buy more nominal value than it was issued for.
#[test]
fn credit_vectors_round_down_and_up() {
    assert_eq!(credit_nominal(E18 / 2, 2 * E18), E18);
    assert_eq!(credit_shares(E18, 2 * E18), E18 / 2);
    assert_eq!(credit_shares_ceil(E18 + 1, 2 * E18), E18 / 2 + 1);
}

/// Protocol constants the vectors depend on.
#[test]
fn protocol_constants() {
    assert_eq!(ONE, E18);
    assert_eq!(MINIMUM_SHARES, 1_000);
}
