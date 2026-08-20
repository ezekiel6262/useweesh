// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title RWARegistry
/// @notice Onchain record of which X Layer tokens represent a real-world asset, who attested
///         to that, and what class the asset belongs to.
/// @dev IntentOS does not custody or issue RWAs. This registry is the onboarding surface:
///      an attestor (issuer, transfer agent, or an oracle acting for one) publishes the link
///      between an offchain asset reference and its token, and intents can then require that
///      every asset they touch is attested (`Policy.requireRwaAttested`).
contract RWARegistry is Ownable {
    enum AssetClass {
        UNKNOWN,
        EQUITY, // xStocks and other tokenized equities
        ETF,
        TREASURY,
        CREDIT,
        COMMODITY,
        REAL_ESTATE,
        OTHER
    }

    struct Attestation {
        bool active;
        AssetClass class_;
        address attestor;
        uint64 attestedAt;
        uint64 reviewBy; // attestation is treated as stale past this timestamp
        string symbol; // e.g. "TSLAx"
        string assetRef; // offchain identifier, e.g. "ISIN:US88160R1014"
        string documentURI; // prospectus / terms / proof of reserve
    }

    /// @notice Onboarding requests from users and agents that are not yet attested.
    struct OnboardingRequest {
        address requester;
        address token; // zero while the token does not exist yet
        AssetClass class_;
        uint64 createdAt;
        bool resolved;
        string assetRef;
        string documentURI;
    }

    mapping(address => Attestation) private _attestations;
    mapping(address => bool) public isAttestor;
    address[] private _attestedTokens;

    OnboardingRequest[] private _requests;

    event AttestorSet(address indexed attestor, bool allowed);
    event AssetAttested(address indexed token, AssetClass class_, string symbol, string assetRef, address attestor);
    event AssetRevoked(address indexed token, address attestor, string reason);
    event OnboardingRequested(uint256 indexed requestId, address indexed requester, string assetRef);
    event OnboardingResolved(uint256 indexed requestId, address indexed token, bool attested);

    error NotAttestor();
    error UnknownRequest();

    modifier onlyAttestor() {
        if (!isAttestor[msg.sender]) revert NotAttestor();
        _;
    }

    constructor(address owner_) Ownable(owner_) {}

    // ------------------------------------------------------------ attestation

    function attest(
        address token,
        AssetClass class_,
        string calldata symbol,
        string calldata assetRef,
        string calldata documentURI,
        uint64 reviewBy
    ) external onlyAttestor {
        Attestation storage a = _attestations[token];
        if (!a.active) {
            _attestedTokens.push(token);
        }
        a.active = true;
        a.class_ = class_;
        a.attestor = msg.sender;
        a.attestedAt = uint64(block.timestamp);
        a.reviewBy = reviewBy;
        a.symbol = symbol;
        a.assetRef = assetRef;
        a.documentURI = documentURI;

        emit AssetAttested(token, class_, symbol, assetRef, msg.sender);
    }

    function revoke(address token, string calldata reason) external onlyAttestor {
        _attestations[token].active = false;
        emit AssetRevoked(token, msg.sender, reason);
    }

    // ------------------------------------------------------------- onboarding

    /// @notice Declare an intent to bring an asset onchain. Anyone may file one; attestors
    ///         resolve it by publishing the attestation for the resulting token.
    function requestOnboarding(
        address token,
        AssetClass class_,
        string calldata assetRef,
        string calldata documentURI
    ) external returns (uint256 requestId) {
        requestId = _requests.length;
        _requests.push(
            OnboardingRequest({
                requester: msg.sender,
                token: token,
                class_: class_,
                createdAt: uint64(block.timestamp),
                resolved: false,
                assetRef: assetRef,
                documentURI: documentURI
            })
        );
        emit OnboardingRequested(requestId, msg.sender, assetRef);
    }

    function resolveOnboarding(uint256 requestId, address token, bool attested) external onlyAttestor {
        if (requestId >= _requests.length) revert UnknownRequest();
        OnboardingRequest storage r = _requests[requestId];
        r.resolved = true;
        r.token = token;
        emit OnboardingResolved(requestId, token, attested);
    }

    // ----------------------------------------------------------------- views

    /// @notice True when the token carries a live, non-stale attestation.
    function isAttested(address token) public view returns (bool) {
        Attestation storage a = _attestations[token];
        if (!a.active) return false;
        if (a.reviewBy != 0 && block.timestamp > a.reviewBy) return false;
        return true;
    }

    function attestationOf(address token) external view returns (Attestation memory) {
        return _attestations[token];
    }

    function attestedTokenCount() external view returns (uint256) {
        return _attestedTokens.length;
    }

    function attestedTokenAt(uint256 index) external view returns (address) {
        return _attestedTokens[index];
    }

    function requestCount() external view returns (uint256) {
        return _requests.length;
    }

    function requestAt(uint256 index) external view returns (OnboardingRequest memory) {
        return _requests[index];
    }

    // ------------------------------------------------------------- governance

    function setAttestor(address attestor, bool allowed) external onlyOwner {
        isAttestor[attestor] = allowed;
        emit AttestorSet(attestor, allowed);
    }
}
