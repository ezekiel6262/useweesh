// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IntentLib} from "./libraries/IntentLib.sol";
import {IDexRouter} from "./interfaces/IDexRouter.sol";
import {IntentRegistry} from "./IntentRegistry.sol";
import {PolicyEngine} from "./PolicyEngine.sol";

/// @title IntentSettlement
/// @notice Executes a winning solver's plan and verifies it against what the user declared.
///
/// This is the only IntentOS contract that touches user funds. The solver supplies the route;
/// the contract supplies the arithmetic. Leg sizing is computed here from the user's declared
/// weights — a solver cannot skew a basket — and every leg must clear both the user's `minOut`
/// and the solver's own auction guarantee, whichever is higher.
contract IntentSettlement is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @param router One of the allowlisted DEX routers on X Layer.
    /// @param path   Swap path, `path[0]` is the token spent and `path[last]` the token received.
    struct Route {
        address router;
        address[] path;
    }

    /// @dev Grouped to keep `settle` within stack limits.
    struct Ctx {
        bytes32 intentId;
        address owner;
        address solver;
        uint16 feeBps;
        uint256 notional;
        uint256 fee;
        uint256 spendable;
        uint256 spent;
    }

    uint16 public constant BPS = 10_000;

    IntentRegistry public immutable registry;
    PolicyEngine public immutable policyEngine;

    /// @notice Protocol success fee, taken as a share of the solver fee.
    uint16 public protocolFeeShareBps = 3_000;
    address public treasury;

    mapping(address => bool) public isRouterAllowed;

    event RouterAllowed(address indexed router, bool allowed);
    event TreasurySet(address treasury);
    event ProtocolFeeShareSet(uint16 bps);
    event IntentSettled(
        bytes32 indexed intentId,
        address indexed solver,
        address indexed recipient,
        uint256 notional,
        uint256 solverFee,
        uint256 protocolFee,
        address[] outputTokens,
        uint256[] outputAmounts
    );
    event ExitExecuted(bytes32 indexed intentId, address indexed token, uint256 amountIn, uint256 baseOut);

    error NotSelectedSolver();
    error IntentNotSelected();
    error PastDeadline();
    error OutcomeMismatch();
    error PolicyMismatch();
    error RouteCountMismatch();
    error RouterNotAllowed(address router);
    error BadPath();
    error BelowFloor(uint256 index, uint256 received, uint256 floor);
    error CapitalUnderdeployed(uint256 spent, uint256 required);
    error ZeroInput();

    constructor(address owner_, IntentRegistry registry_, PolicyEngine policyEngine_, address treasury_)
        Ownable(owner_)
    {
        registry = registry_;
        policyEngine = policyEngine_;
        treasury = treasury_;
    }

    // ---------------------------------------------------------------- settle

    /// @notice Reveal the committed outcome and policy, execute the plan, verify the result.
    /// @dev Callable only by the solver whose bid won the auction for `intentId`.
    function settle(
        bytes32 intentId,
        IntentLib.Outcome calldata outcome,
        IntentLib.Policy calldata policy,
        Route[] calldata entryRoutes,
        Route[] calldata exitRoutes
    ) external nonReentrant returns (uint256[] memory received) {
        Ctx memory c = _open(intentId, outcome, policy, entryRoutes, exitRoutes);

        c.notional = _collect(c, outcome, exitRoutes);
        if (c.notional == 0) revert ZeroInput();

        policyEngine.check(outcome, policy, c.solver, c.notional, c.feeBps);

        c.fee = (c.notional * c.feeBps) / BPS;
        c.spendable = c.notional - c.fee;

        received = _acquire(c, outcome, entryRoutes);

        // The solver must actually deploy the capital it was handed; `maxSlippageBps` bounds
        // how much of the notional may be left behind as rounding and routing dust.
        uint256 required = (c.spendable * (BPS - outcome.maxSlippageBps)) / BPS;
        if (c.spent < required) revert CapitalUnderdeployed(c.spent, required);

        uint256 protocolFee = _payFees(outcome.inputToken, c);
        _refundDust(outcome.inputToken, c);

        registry.markFulfilled(intentId, c.notional, c.fee);

        emit IntentSettled(
            intentId,
            c.solver,
            outcome.recipient,
            c.notional,
            c.fee - protocolFee,
            protocolFee,
            _tokensOf(outcome.legs),
            received
        );
    }

    /// @notice Give up on a selected intent. Returns it to auction and takes the reputation hit.
    function reportFailure(bytes32 intentId, string calldata reason) external {
        IntentRegistry.IntentRecord memory r = registry.getIntent(intentId);
        if (msg.sender != r.selectedSolver) revert NotSelectedSolver();
        registry.markFailed(intentId, reason);
    }

    // -------------------------------------------------------------- internals

    function _open(
        bytes32 intentId,
        IntentLib.Outcome calldata outcome,
        IntentLib.Policy calldata policy,
        Route[] calldata entryRoutes,
        Route[] calldata exitRoutes
    ) private view returns (Ctx memory c) {
        IntentRegistry.IntentRecord memory r = registry.getIntent(intentId);
        if (r.status != IntentLib.Status.SELECTED) revert IntentNotSelected();
        if (msg.sender != r.selectedSolver) revert NotSelectedSolver();
        if (block.timestamp > r.deadline) revert PastDeadline();
        if (IntentLib.hashOutcome(outcome) != r.outcomeHash) revert OutcomeMismatch();
        if (IntentLib.hashPolicy(policy) != r.policyHash) revert PolicyMismatch();
        if (entryRoutes.length != outcome.legs.length) revert RouteCountMismatch();
        if (exitRoutes.length != outcome.exits.length) revert RouteCountMismatch();

        c.intentId = intentId;
        c.owner = r.owner;
        c.solver = r.selectedSolver;
        c.feeBps = registry.selectedBidOf(intentId).feeBps;
    }

    /// @notice Bring the input notional into this contract: direct deposit, exit legs, or both.
    function _collect(Ctx memory c, IntentLib.Outcome calldata outcome, Route[] calldata exitRoutes)
        private
        returns (uint256 notional)
    {
        IERC20 base = IERC20(outcome.inputToken);

        if (outcome.inputAmount > 0) {
            base.safeTransferFrom(c.owner, address(this), outcome.inputAmount);
            notional = outcome.inputAmount;
        }

        for (uint256 i = 0; i < outcome.exits.length; i++) {
            IntentLib.ExitLeg calldata exit = outcome.exits[i];
            IERC20(exit.token).safeTransferFrom(c.owner, address(this), exit.amountIn);
            uint256 out = _swap(exitRoutes[i], exit.token, outcome.inputToken, exit.amountIn, exit.minOut, address(this));
            if (out < exit.minOut) revert BelowFloor(i, out, exit.minOut);
            notional += out;
            emit ExitExecuted(c.intentId, exit.token, exit.amountIn, out);
        }
    }

    /// @notice Buy every acquisition leg at the user's declared weights.
    function _acquire(Ctx memory c, IntentLib.Outcome calldata outcome, Route[] calldata entryRoutes)
        private
        returns (uint256[] memory received)
    {
        uint256 n = outcome.legs.length;
        received = new uint256[](n);
        uint256 budget = c.spendable;

        for (uint256 i = 0; i < n; i++) {
            IntentLib.BasketLeg calldata leg = outcome.legs[i];
            // Sizing is computed from the committed weights, never taken from the solver.
            // The final leg absorbs the rounding remainder so the whole budget is deployable.
            uint256 amountIn =
                i + 1 == n ? budget - c.spent : (budget * leg.weightBps) / BPS;
            if (amountIn == 0) continue;

            uint256 floor_ = _floorFor(c.intentId, i, leg.minOut);
            uint256 out;
            if (leg.token == outcome.inputToken) {
                // Holding the input asset is a valid leg (e.g. a cash sleeve in a basket).
                IERC20(outcome.inputToken).safeTransfer(outcome.recipient, amountIn);
                out = amountIn;
            } else {
                out = _swap(entryRoutes[i], outcome.inputToken, leg.token, amountIn, floor_, outcome.recipient);
            }
            if (out < floor_) revert BelowFloor(i, out, floor_);

            received[i] = out;
            c.spent += amountIn;
        }
    }

    /// @notice The binding floor for a leg: the user's own minimum, raised to the solver's
    ///         auction guarantee when the solver promised more.
    function _floorFor(bytes32 intentId, uint256 legIndex, uint256 userMinOut) private view returns (uint256) {
        uint256 guaranteed = registry.selectedBidOf(intentId).guaranteedOut[legIndex];
        return guaranteed > userMinOut ? guaranteed : userMinOut;
    }

    function _swap(
        Route calldata route,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        address to
    ) private returns (uint256) {
        if (!isRouterAllowed[route.router]) revert RouterNotAllowed(route.router);
        uint256 len = route.path.length;
        if (len < 2 || route.path[0] != tokenIn || route.path[len - 1] != tokenOut) revert BadPath();

        IERC20(tokenIn).forceApprove(route.router, amountIn);
        uint256 before = IERC20(tokenOut).balanceOf(to);
        IDexRouter(route.router).swapExactTokensForTokens(amountIn, amountOutMin, route.path, to, block.timestamp);
        IERC20(tokenIn).forceApprove(route.router, 0);

        // Measured, not reported: the router's return value is never trusted for verification.
        return IERC20(tokenOut).balanceOf(to) - before;
    }

    function _payFees(address token, Ctx memory c) private returns (uint256 protocolFee) {
        if (c.fee == 0) return 0;
        protocolFee = (c.fee * protocolFeeShareBps) / BPS;
        if (protocolFee > 0) {
            IERC20(token).safeTransfer(treasury, protocolFee);
        }
        uint256 solverFee = c.fee - protocolFee;
        if (solverFee > 0) {
            IERC20(token).safeTransfer(c.solver, solverFee);
        }
    }

    function _refundDust(address token, Ctx memory c) private {
        uint256 leftover = c.spendable - c.spent;
        if (leftover > 0) {
            IERC20(token).safeTransfer(c.owner, leftover);
        }
    }

    function _tokensOf(IntentLib.BasketLeg[] calldata legs) private pure returns (address[] memory tokens) {
        tokens = new address[](legs.length);
        for (uint256 i = 0; i < legs.length; i++) {
            tokens[i] = legs[i].token;
        }
    }

    // ------------------------------------------------------------- governance

    function setRouterAllowed(address router, bool allowed) external onlyOwner {
        isRouterAllowed[router] = allowed;
        emit RouterAllowed(router, allowed);
    }

    function setTreasury(address treasury_) external onlyOwner {
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function setProtocolFeeShareBps(uint16 bps) external onlyOwner {
        require(bps <= BPS, "bps");
        protocolFeeShareBps = bps;
        emit ProtocolFeeShareSet(bps);
    }
}
