// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-1271 account so a smart-account owner can sign Submit.
contract MockSmartAccount {
    address public owner;
    bytes4 private constant MAGIC = 0x1626ba7e;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 65) return 0xffffffff;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        address signer = ecrecover(hash, v, r, s);
        return signer == owner ? MAGIC : bytes4(0xffffffff);
    }
}
