// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IDexRouter} from "../interfaces/IDexRouter.sol";

/// @notice A priced, depth-aware stand-in for an X Layer DEX router.
/// @dev Deployed more than once in the demo with different prices, fees and depth, so solvers
///      genuinely have something to compete over: venue choice and trade sizing change the
///      outputs a solver can guarantee. Quotes are decimal-aware (USDT is 6dp, xStocks 18dp).
contract MockDexRouter is IDexRouter {
    using SafeERC20 for IERC20;

    uint256 private constant WAD = 1e18;
    uint16 private constant BPS = 10_000;
    uint16 public constant MAX_IMPACT_BPS = 1_500;

    /// @notice Price of one whole tokenIn expressed in whole tokenOut, scaled by 1e18.
    mapping(address => mapping(address => uint256)) public priceE18;
    /// @notice Notional (in tokenIn units) that moves the price by 1 bp of impact.
    mapping(address => mapping(address => uint256)) public depth;

    uint16 public feeBps;
    string public venue;

    error NoPrice(address tokenIn, address tokenOut);
    error InsufficientOutput(uint256 out, uint256 min);
    error PathTooShort();
    error Expired();

    constructor(string memory venue_, uint16 feeBps_) {
        venue = venue_;
        feeBps = feeBps_;
    }

    function setPrice(address tokenIn, address tokenOut, uint256 priceE18_, uint256 depth_) external {
        priceE18[tokenIn][tokenOut] = priceE18_;
        depth[tokenIn][tokenOut] = depth_;
        // Quote the inverse leg too, so exits work without a second call.
        if (priceE18_ != 0) {
            priceE18[tokenOut][tokenIn] = (WAD * WAD) / priceE18_;
            depth[tokenOut][tokenIn] = depth_ == 0 ? 0 : (depth_ * priceE18_) / WAD;
        }
    }

    function setFeeBps(uint16 feeBps_) external {
        feeBps = feeBps_;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        public
        view
        override
        returns (uint256[] memory amounts)
    {
        if (path.length < 2) revert PathTooShort();
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i = 0; i + 1 < path.length; i++) {
            amounts[i + 1] = _quote(path[i], path[i + 1], amounts[i]);
        }
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external override returns (uint256[] memory amounts) {
        if (block.timestamp > deadline) revert Expired();
        amounts = getAmountsOut(amountIn, path);
        uint256 out = amounts[amounts.length - 1];
        if (out < amountOutMin) revert InsufficientOutput(out, amountOutMin);

        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(path[path.length - 1]).safeTransfer(to, out);
    }

    function _quote(address tokenIn, address tokenOut, uint256 amountIn) private view returns (uint256) {
        uint256 p = priceE18[tokenIn][tokenOut];
        if (p == 0) revert NoPrice(tokenIn, tokenOut);

        uint8 decIn = IERC20Metadata(tokenIn).decimals();
        uint8 decOut = IERC20Metadata(tokenOut).decimals();

        uint256 out = (amountIn * p) / WAD;
        out = (out * (10 ** decOut)) / (10 ** decIn);
        out = (out * (BPS - feeBps)) / BPS;

        uint256 d = depth[tokenIn][tokenOut];
        if (d != 0) {
            uint256 impact = amountIn / d;
            if (impact > MAX_IMPACT_BPS) impact = MAX_IMPACT_BPS;
            out = (out * (BPS - impact)) / BPS;
        }
        return out;
    }
}
