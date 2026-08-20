// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal UniswapV2-style router surface. The major X Layer DEXs expose it, which is
///         why IntentOS routes through it rather than a bespoke adapter per venue.
interface IDexRouter {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);
}
