// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntentLib} from "./libraries/IntentLib.sol";
import {SolverRegistry} from "./SolverRegistry.sol";
import {RWARegistry} from "./RWARegistry.sol";

/// @title PolicyEngine
/// @notice Enforces the programmable guardrails attached to an intent.
/// @dev Kept as its own contract so guardrail logic can evolve (new policy dimensions,
///      richer RWA rules) without touching the contract that moves funds.
contract PolicyEngine {
    SolverRegistry public immutable solvers;
    RWARegistry public immutable rwa;

    uint16 public constant BPS = 10_000;
    /// @notice Ceiling on any single settlement's slippage tolerance, whatever the intent says.
    uint16 public constant MAX_SLIPPAGE_BPS = 2_000;

    error PolicyNotYetValid();
    error PolicyExpired();
    error NotionalTooLarge();
    error FeeTooHigh();
    error SolverReputationTooLow();
    error TokenNotAllowed(address token);
    error AssetNotAttested(address token);
    error SlippageTooHigh();
    error WeightsInvalid();
    error NoLegs();
    error SolverNotCompliant();
    error SolverCannotSponsorGas();

    /// @dev Mirrors SolverRegistry.CAP_GASLESS.
    uint32 public constant CAP_GASLESS = 32;

    constructor(SolverRegistry solvers_, RWARegistry rwa_) {
        solvers = solvers_;
        rwa = rwa_;
    }

    /// @notice Reverts unless the outcome, the policy and the chosen solver are all acceptable.
    function check(
        IntentLib.Outcome calldata outcome,
        IntentLib.Policy calldata policy,
        address solver,
        uint256 notional,
        uint16 feeBps
    ) external view {
        if (outcome.legs.length == 0) revert NoLegs();
        if (outcome.maxSlippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh();
        if (IntentLib.totalWeightBps(outcome.legs) != BPS) revert WeightsInvalid();

        if (policy.validAfter != 0 && block.timestamp < policy.validAfter) revert PolicyNotYetValid();
        if (policy.validUntil != 0 && block.timestamp > policy.validUntil) revert PolicyExpired();
        if (policy.maxNotional != 0 && notional > policy.maxNotional) revert NotionalTooLarge();
        if (feeBps > policy.maxFeeBps) revert FeeTooHigh();
        if (solvers.reputationOf(solver) < policy.minReputationBps) revert SolverReputationTooLow();
        if (policy.requireCompliant && !solvers.kybAttested(solver)) revert SolverNotCompliant();
        if (policy.sponsorGas && !solvers.hasCapabilities(solver, CAP_GASLESS)) revert SolverCannotSponsorGas();

        for (uint256 i = 0; i < outcome.legs.length; i++) {
            address token = outcome.legs[i].token;
            if (policy.tokenAllowlist.length != 0 && !_allowed(policy.tokenAllowlist, token)) {
                revert TokenNotAllowed(token);
            }
            if (policy.requireRwaAttested && !rwa.isAttested(token)) revert AssetNotAttested(token);
        }
        for (uint256 i = 0; i < outcome.exits.length; i++) {
            address token = outcome.exits[i].token;
            if (policy.tokenAllowlist.length != 0 && !_allowed(policy.tokenAllowlist, token)) {
                revert TokenNotAllowed(token);
            }
        }
    }

    function _allowed(address[] calldata allowlist, address token) private pure returns (bool) {
        for (uint256 i = 0; i < allowlist.length; i++) {
            if (allowlist[i] == token) return true;
        }
        return false;
    }
}
