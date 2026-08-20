// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IntentLib
/// @notice Canonical structs and hashing for the IntentOS Intent Standard v0.1.
/// @dev The encodings here are mirrored byte-for-byte by `@intentos/intent-schema`
///      (see packages/intent-schema/src/hash.ts). Any change must be made in both places;
///      the shared test vectors in contracts/test/Hashing.t.ts guard the invariant.
library IntentLib {
    /// @notice What the declared outcome is about. Determines which reveal struct is valid.
    enum Kind {
        SWAP, // single asset in -> single asset out
        BASKET, // single asset in -> weighted set of assets out (xStocks portfolios)
        REBALANCE, // exit legs -> base asset -> entry legs, in one atomic settlement
        RWA_ONBOARD, // acquire an attested tokenized real-world asset
        BATCH, // several of the above declared together
        PAYMENT // 1:1 stablecoin send, including a cash sleeve of the input asset
    }

    enum Status {
        NONE,
        OPEN, // accepting solver bids
        SELECTED, // a winning bid has been chosen, awaiting settlement
        FULFILLED,
        CANCELLED,
        EXPIRED
    }

    /// @notice One target asset of a BASKET (or the entry side of a REBALANCE).
    /// @param token       Output token to acquire.
    /// @param weightBps   Share of the input notional to spend on this token.
    /// @param minOut      Absolute floor on units received. Enforced at settlement.
    struct BasketLeg {
        address token;
        uint16 weightBps;
        uint256 minOut;
    }

    /// @notice One position being exited during a REBALANCE.
    struct ExitLeg {
        address token;
        uint256 amountIn;
        uint256 minOut; // floor on base token received for this leg
    }

    /// @notice The user-declared outcome. Committed as a hash at submission,
    ///         revealed and enforced at settlement.
    struct Outcome {
        Kind kind;
        address inputToken; // asset the user parts with (base asset for REBALANCE)
        uint256 inputAmount; // 0 for REBALANCE (funded by the exit legs)
        address recipient; // where outputs land
        uint16 maxSlippageBps; // ceiling applied on top of every leg's minOut
        BasketLeg[] legs; // acquisition legs (length 1 for SWAP / RWA_ONBOARD)
        ExitLeg[] exits; // REBALANCE only
    }

    /// @notice Programmable guardrails. Committed at submission, enforced at settlement.
    /// @param maxNotional        Hard cap on input notional the settlement may spend.
    /// @param tokenAllowlist     If non-empty, every output token must appear here.
    /// @param minReputationBps   Floor on the winning solver's reputation score.
    /// @param requireRwaAttested Every output token must be attested in the RWARegistry.
    /// @param requireCompliant   Winning solver must carry a live KYB attestation.
    /// @param sponsorGas         Winning solver must be willing to pay settlement gas.
    struct Policy {
        uint256 maxNotional;
        uint64 validAfter;
        uint64 validUntil;
        uint16 maxFeeBps;
        uint16 minReputationBps;
        bool requireRwaAttested;
        bool requireCompliant;
        bool sponsorGas;
        address[] tokenAllowlist;
    }

    uint16 internal constant BPS = 10_000;

    function hashOutcome(Outcome memory o) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256("IntentOS.Outcome.v1"),
                    uint8(o.kind),
                    o.inputToken,
                    o.inputAmount,
                    o.recipient,
                    o.maxSlippageBps,
                    hashLegs(o.legs),
                    hashExits(o.exits)
                )
            );
    }

    function hashLegs(BasketLeg[] memory legs) internal pure returns (bytes32) {
        bytes32[] memory items = new bytes32[](legs.length);
        for (uint256 i = 0; i < legs.length; i++) {
            items[i] = keccak256(abi.encode(legs[i].token, legs[i].weightBps, legs[i].minOut));
        }
        return keccak256(abi.encodePacked(items));
    }

    function hashExits(ExitLeg[] memory exits) internal pure returns (bytes32) {
        bytes32[] memory items = new bytes32[](exits.length);
        for (uint256 i = 0; i < exits.length; i++) {
            items[i] = keccak256(abi.encode(exits[i].token, exits[i].amountIn, exits[i].minOut));
        }
        return keccak256(abi.encodePacked(items));
    }

    function hashPolicy(Policy memory p) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256("IntentOS.Policy.v2"),
                    p.maxNotional,
                    p.validAfter,
                    p.validUntil,
                    p.maxFeeBps,
                    p.minReputationBps,
                    p.requireRwaAttested,
                    p.requireCompliant,
                    p.sponsorGas,
                    keccak256(abi.encodePacked(p.tokenAllowlist))
                )
            );
    }

    /// @notice Sum of acquisition weights. Must equal 10_000 for a well-formed outcome.
    function totalWeightBps(BasketLeg[] memory legs) internal pure returns (uint256 total) {
        for (uint256 i = 0; i < legs.length; i++) {
            total += legs[i].weightBps;
        }
    }
}
