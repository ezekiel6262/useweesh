// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";


interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}

/// @title V3RouterAdapter
/// @notice Presents Uniswap V3 SwapRouter02 as the UniswapV2-style IDexRouter IntentOS already speaks.
/// @dev getAmountsOut is intentionally non-view: QuoterV2 simulates a swap. eth_call still works.
contract V3RouterAdapter {
    using SafeERC20 for IERC20;

    ISwapRouter02 public immutable swapRouter;
    IQuoterV2 public immutable quoter;
    uint24[4] public fees;

    error NoRoute();

    constructor(address swapRouter_, address quoter_) {
        swapRouter = ISwapRouter02(swapRouter_);
        quoter = IQuoterV2(quoter_);
        fees = [uint24(100), uint24(500), uint24(3_000), uint24(10_000)];
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external returns (uint256[] memory amounts) {
        uint256 n = path.length;
        amounts = new uint256[](n);
        amounts[0] = amountIn;
        for (uint256 i = 0; i + 1 < n; i++) {
            (uint256 out, ) = _bestQuote(path[i], path[i + 1], amounts[i]);
            if (out == 0) revert NoRoute();
            amounts[i + 1] = out;
        }
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external returns (uint256[] memory amounts) {
        uint256 n = path.length;
        if (n < 2) revert NoRoute();
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);

        amounts = new uint256[](n);
        amounts[0] = amountIn;
        uint256 current = amountIn;
        for (uint256 i = 0; i + 1 < n; i++) {
            address tokenIn = path[i];
            address tokenOut = path[i + 1];
            (, uint24 fee) = _bestQuote(tokenIn, tokenOut, current);
            IERC20(tokenIn).forceApprove(address(swapRouter), current);
            address recipient = i + 2 == n ? to : address(this);
            uint256 out = swapRouter.exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: recipient,
                    amountIn: current,
                    amountOutMinimum: i + 2 == n ? amountOutMin : 0,
                    sqrtPriceLimitX96: 0
                })
            );
            IERC20(tokenIn).forceApprove(address(swapRouter), 0);
            amounts[i + 1] = out;
            current = out;
        }
        if (amounts[n - 1] < amountOutMin) revert NoRoute();
    }

    function _bestQuote(address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256 bestOut, uint24 bestFee) {
        for (uint256 i = 0; i < fees.length; i++) {
            uint24 fee = fees[i];
            try quoter.quoteExactInputSingle(
                IQuoterV2.QuoteExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    amountIn: amountIn,
                    fee: fee,
                    sqrtPriceLimitX96: 0
                })
            ) returns (uint256 amountOut, uint160, uint32, uint256) {
                if (amountOut > bestOut) {
                    bestOut = amountOut;
                    bestFee = fee;
                }
            } catch {}
        }
    }
}
