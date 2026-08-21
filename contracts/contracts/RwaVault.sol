// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RWARegistry} from "./RWARegistry.sol";

/// @title RwaVault
/// @notice 1:1 share vault over an attested RWA token. Deposit the xStock, hold vault shares.
contract RwaVault is ERC20, Ownable {
    IERC20 public immutable asset;
    RWARegistry public immutable rwa;
    uint8 private immutable _decimals;

    error NotAttested();
    error ZeroAmount();

    constructor(
        address owner_,
        address asset_,
        address rwa_,
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) Ownable(owner_) {
        asset = IERC20(asset_);
        rwa = RWARegistry(rwa_);
        _decimals = IERC20Metadata(asset_).decimals();
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (!rwa.isAttested(address(asset))) revert NotAttested();
        asset.transferFrom(msg.sender, address(this), amount);
        _mint(msg.sender, amount);
    }

    function withdraw(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        _burn(msg.sender, amount);
        asset.transfer(msg.sender, amount);
    }
}
