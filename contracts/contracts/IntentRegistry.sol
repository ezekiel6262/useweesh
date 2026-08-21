// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IntentLib} from "./libraries/IntentLib.sol";
import {SolverRegistry} from "./SolverRegistry.sol";

/// @title IntentRegistry
/// @notice The intent lifecycle and solver auction for IntentOS on X Layer.
///
/// An intent is submitted as a commitment: the hash of the declared outcome and the hash of
/// the policy that guards it. Solvers bid a fee and a vector of guaranteed outputs — one per
/// acquisition leg — during an auction window. A winner is selected, and IntentSettlement
/// later reveals the outcome and the winning plan and enforces both.
///
/// @dev Trust model. Selection may be performed by the intent owner, or delegated to a bonded
///      auctioneer (the IntentOS coordinator) so that agents do not have to stay online. A
///      dishonest auctioneer cannot harm the user directly — settlement independently enforces
///      the user's own `minOut`s, slippage ceiling and policy — but it could pick a worse
///      solver. That is made costly onchain: bids are public, and `challengeSelection` slashes
///      the auctioneer's bond whenever a recorded bid *Pareto-dominates* the selected one
///      (no worse on every leg and no worse on fee, strictly better somewhere). Dominance is
///      comparable without a price oracle, which is why selection integrity is enforceable here
///      while full onchain scoring is not.
contract IntentRegistry is Ownable, ReentrancyGuard {
    using IntentLib for IntentLib.BasketLeg[];

    struct IntentRecord {
        address owner;
        IntentLib.Kind kind;
        IntentLib.Status status;
        uint16 legCount;
        uint64 createdAt;
        uint64 auctionEndsAt;
        uint64 deadline;
        bytes32 outcomeHash;
        bytes32 policyHash;
        address selectedSolver;
        uint32 selectedBid;
        bool ownerSelected; // selection made by the owner => not challengeable
        address integrator; // if set, only this address (or the owner) may select
    }

    struct Bid {
        address solver;
        uint64 placedAt;
        uint16 feeBps;
        uint32 etaSeconds;
        bytes32 planHash;
        uint256[] guaranteedOut; // aligned with Outcome.legs
        bool withdrawn;
    }

    uint16 public constant BPS = 10_000;
    uint64 public constant MIN_AUCTION_WINDOW = 3 seconds;
    bytes32 public constant SUBMIT_TYPEHASH = keccak256(
        "Submit(address owner,uint8 kind,bytes32 outcomeHash,bytes32 policyHash,bytes32 salt,uint64 auctionEndsAt,uint64 deadline,uint16 legCount,address integrator,string metadataURI,uint256 nonce)"
    );

    mapping(address => uint256) public nonces;

    SolverRegistry public immutable solvers;

    /// @notice Contract allowed to move intents to FULFILLED / FAILED (IntentSettlement).
    address public settlement;
    /// @notice Delegate allowed to select winners on behalf of owners.
    address public auctioneer;
    /// @notice Auctioneer's slashable bond, posted in the native token.
    uint256 public auctioneerBond;
    /// @notice Share of the auctioneer bond paid to a successful challenger.
    uint16 public challengeRewardBps = 2_000;

    mapping(bytes32 => IntentRecord) private _intents;
    mapping(bytes32 => Bid[]) private _bids;
    /// @notice Intent ids in submission order, for indexers and the dashboard.
    bytes32[] private _intentIds;
    mapping(address => bytes32[]) private _byOwner;

    event IntentSubmitted(
        bytes32 indexed intentId,
        address indexed owner,
        IntentLib.Kind kind,
        bytes32 outcomeHash,
        bytes32 policyHash,
        uint16 legCount,
        uint64 auctionEndsAt,
        uint64 deadline,
        string metadataURI
    );
    event BidPlaced(bytes32 indexed intentId, uint32 indexed bidId, address indexed solver, uint16 feeBps, bytes32 planHash);
    event BidWithdrawn(bytes32 indexed intentId, uint32 indexed bidId, address indexed solver);
    event WinnerSelected(bytes32 indexed intentId, uint32 indexed bidId, address indexed solver, bool byOwner);
    event IntentFulfilled(bytes32 indexed intentId, address indexed solver, uint256 notional, uint256 feePaid);
    event IntentFailed(bytes32 indexed intentId, address indexed solver, string reason);
    event IntentCancelled(bytes32 indexed intentId, address indexed owner);
    event IntentExpired(bytes32 indexed intentId);
    event SelectionChallenged(bytes32 indexed intentId, address indexed challenger, uint32 dominatingBid, uint256 reward);
    event SettlementSet(address settlement);
    event AuctioneerSet(address auctioneer);

    error IntentExists();
    error UnknownIntent();
    error BadStatus();
    error BadTiming();
    error BadLegCount();
    error NotOwner();
    error NotSettlement();
    error NotSelector();
    error SolverInactive();
    error AuctionClosed();
    error AuctionStillOpen();
    error UnknownBid();
    error NotDominating();
    error NotChallengeable();
    error TransferFailed();
    error BadSignature();

    constructor(address owner_, SolverRegistry solvers_) Ownable(owner_) {
        solvers = solvers_;
    }

    modifier onlySettlement() {
        if (msg.sender != settlement) revert NotSettlement();
        _;
    }

    // ------------------------------------------------------------ submission

    /// @notice The canonical id of an intent. Derived rather than supplied, so nobody can
    ///         squat on an id another account is about to use.
    function computeIntentId(
        address owner,
        bytes32 outcomeHash,
        bytes32 policyHash,
        bytes32 salt,
        uint64 auctionEndsAt,
        uint64 deadline
    ) public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256("IntentOS.Intent.v1"),
                    block.chainid,
                    address(this),
                    owner,
                    outcomeHash,
                    policyHash,
                    salt,
                    auctionEndsAt,
                    deadline
                )
            );
    }

    /// @notice Declare an outcome as a commitment. Only the hashes go onchain now; the outcome
    ///         and policy are revealed at settlement and enforced there.
    function submit(
        bytes32 salt,
        IntentLib.Kind kind,
        bytes32 outcomeHash,
        bytes32 policyHash,
        uint16 legCount,
        uint64 auctionEndsAt,
        uint64 deadline,
        string calldata metadataURI
    ) external returns (bytes32) {
        return _open(
            msg.sender, salt, kind, outcomeHash, policyHash, legCount, auctionEndsAt, deadline, address(0), metadataURI
        );
    }

    /// @notice Gasless submit. `owner` signs an EIP-712 `Submit`; the relayer (any account, typically
    ///         the coordinator) pays gas. `integrator` pins selection to a named controller when set.
    function submitFor(
        address owner,
        bytes32 salt,
        IntentLib.Kind kind,
        bytes32 outcomeHash,
        bytes32 policyHash,
        uint16 legCount,
        uint64 auctionEndsAt,
        uint64 deadline,
        address integrator,
        string calldata metadataURI,
        bytes calldata signature
    ) external returns (bytes32) {
        uint256 nonce = nonces[owner]++;
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SUBMIT_TYPEHASH,
                    owner,
                    uint8(kind),
                    outcomeHash,
                    policyHash,
                    salt,
                    auctionEndsAt,
                    deadline,
                    legCount,
                    integrator,
                    keccak256(bytes(metadataURI)),
                    nonce
                )
            )
        );
        if (_recover(digest, signature) != owner) revert BadSignature();
        return _open(owner, salt, kind, outcomeHash, policyHash, legCount, auctionEndsAt, deadline, integrator, metadataURI);
    }

    function _open(
        address owner,
        bytes32 salt,
        IntentLib.Kind kind,
        bytes32 outcomeHash,
        bytes32 policyHash,
        uint16 legCount,
        uint64 auctionEndsAt,
        uint64 deadline,
        address integrator,
        string calldata metadataURI
    ) private returns (bytes32) {
        bytes32 intentId = computeIntentId(owner, outcomeHash, policyHash, salt, auctionEndsAt, deadline);
        if (_intents[intentId].status != IntentLib.Status.NONE) revert IntentExists();
        if (legCount == 0) revert BadLegCount();
        if (auctionEndsAt < block.timestamp + MIN_AUCTION_WINDOW) revert BadTiming();
        if (deadline <= auctionEndsAt) revert BadTiming();

        _intents[intentId] = IntentRecord({
            owner: owner,
            kind: kind,
            status: IntentLib.Status.OPEN,
            legCount: legCount,
            createdAt: uint64(block.timestamp),
            auctionEndsAt: auctionEndsAt,
            deadline: deadline,
            outcomeHash: outcomeHash,
            policyHash: policyHash,
            selectedSolver: address(0),
            selectedBid: 0,
            ownerSelected: false,
            integrator: integrator
        });
        _intentIds.push(intentId);
        _byOwner[owner].push(intentId);

        emit IntentSubmitted(intentId, owner, kind, outcomeHash, policyHash, legCount, auctionEndsAt, deadline, metadataURI);
        return intentId;
    }

    function cancel(bytes32 intentId) external {
        IntentRecord storage r = _load(intentId);
        if (r.owner != msg.sender) revert NotOwner();
        if (r.status != IntentLib.Status.OPEN && r.status != IntentLib.Status.SELECTED) revert BadStatus();
        r.status = IntentLib.Status.CANCELLED;
        emit IntentCancelled(intentId, msg.sender);
    }

    /// @notice Permissionless: retire an intent whose deadline passed without settlement.
    function expire(bytes32 intentId) external {
        IntentRecord storage r = _load(intentId);
        if (r.status != IntentLib.Status.OPEN && r.status != IntentLib.Status.SELECTED) revert BadStatus();
        if (block.timestamp <= r.deadline) revert BadTiming();

        // A solver that won the auction and then let the intent expire is marked down.
        if (r.status == IntentLib.Status.SELECTED && r.selectedSolver != address(0)) {
            solvers.reportOutcome(r.selectedSolver, false, 0);
        }
        r.status = IntentLib.Status.EXPIRED;
        emit IntentExpired(intentId);
    }

    // --------------------------------------------------------------- auction

    /// @param guaranteedOut Floor on units delivered per acquisition leg. Binding: settlement
    ///        enforces the winning bid's guarantees, which sit on top of the user's own minOuts.
    function placeBid(
        bytes32 intentId,
        uint16 feeBps,
        uint32 etaSeconds,
        bytes32 planHash,
        uint256[] calldata guaranteedOut
    ) external returns (uint32 bidId) {
        IntentRecord storage r = _load(intentId);
        if (r.status != IntentLib.Status.OPEN) revert BadStatus();
        if (block.timestamp > r.auctionEndsAt) revert AuctionClosed();
        if (guaranteedOut.length != r.legCount) revert BadLegCount();
        if (!solvers.isActive(msg.sender)) revert SolverInactive();

        bidId = uint32(_bids[intentId].length);
        _bids[intentId].push(
            Bid({
                solver: msg.sender,
                placedAt: uint64(block.timestamp),
                feeBps: feeBps,
                etaSeconds: etaSeconds,
                planHash: planHash,
                guaranteedOut: guaranteedOut,
                withdrawn: false
            })
        );
        emit BidPlaced(intentId, bidId, msg.sender, feeBps, planHash);
    }

    function withdrawBid(bytes32 intentId, uint32 bidId) external {
        IntentRecord storage r = _load(intentId);
        if (r.status != IntentLib.Status.OPEN) revert BadStatus();
        if (block.timestamp > r.auctionEndsAt) revert AuctionClosed();
        Bid storage b = _bid(intentId, bidId);
        if (b.solver != msg.sender) revert NotOwner();
        b.withdrawn = true;
        emit BidWithdrawn(intentId, bidId, msg.sender);
    }

    /// @notice Choose the winning bid. Callable by the intent owner at any point after the
    ///         auction window, or by the bonded auctioneer on the owner's behalf.
    function selectWinner(bytes32 intentId, uint32 bidId) external {
        IntentRecord storage r = _load(intentId);
        if (r.status != IntentLib.Status.OPEN) revert BadStatus();
        if (block.timestamp < r.auctionEndsAt) revert AuctionStillOpen();
        if (block.timestamp > r.deadline) revert BadTiming();

        bool byOwner = msg.sender == r.owner;
        address controller = r.integrator == address(0) ? auctioneer : r.integrator;
        if (!byOwner && msg.sender != controller) revert NotSelector();

        Bid storage b = _bid(intentId, bidId);
        if (b.withdrawn) revert UnknownBid();
        if (!solvers.isActive(b.solver)) revert SolverInactive();

        r.status = IntentLib.Status.SELECTED;
        r.selectedSolver = b.solver;
        r.selectedBid = bidId;
        r.ownerSelected = byOwner;

        emit WinnerSelected(intentId, bidId, b.solver, byOwner);
    }

    /// @notice Prove the auctioneer passed over a strictly better bid and take a cut of its bond.
    /// @dev Open until the intent leaves SELECTED. A dominating bid is one that guarantees at
    ///      least as much on every leg and charges no more, and beats the winner somewhere.
    function challengeSelection(bytes32 intentId, uint32 dominatingBidId) external nonReentrant {
        IntentRecord storage r = _load(intentId);
        if (r.status != IntentLib.Status.SELECTED) revert BadStatus();
        if (r.ownerSelected) revert NotChallengeable();

        Bid storage winner = _bid(intentId, r.selectedBid);
        Bid storage other = _bid(intentId, dominatingBidId);
        if (other.withdrawn || other.solver == winner.solver) revert NotDominating();
        if (!_dominates(other, winner)) revert NotDominating();

        uint256 reward = (auctioneerBond * challengeRewardBps) / BPS;
        auctioneerBond -= reward;

        // Reopen the auction so the intent can still be served.
        r.status = IntentLib.Status.OPEN;
        r.selectedSolver = address(0);
        r.selectedBid = 0;

        if (reward > 0) {
            (bool ok, ) = msg.sender.call{value: reward}("");
            if (!ok) revert TransferFailed();
        }
        emit SelectionChallenged(intentId, msg.sender, dominatingBidId, reward);
    }

    function _dominates(Bid storage a, Bid storage b) private view returns (bool) {
        if (a.feeBps > b.feeBps) return false;
        if (a.guaranteedOut.length != b.guaranteedOut.length) return false;
        bool strict = a.feeBps < b.feeBps;
        for (uint256 i = 0; i < a.guaranteedOut.length; i++) {
            if (a.guaranteedOut[i] < b.guaranteedOut[i]) return false;
            if (a.guaranteedOut[i] > b.guaranteedOut[i]) strict = true;
        }
        return strict;
    }

    // ------------------------------------------------------------ settlement

    function markFulfilled(bytes32 intentId, uint256 notional, uint256 feePaid) external onlySettlement {
        IntentRecord storage r = _load(intentId);
        if (r.status != IntentLib.Status.SELECTED) revert BadStatus();
        r.status = IntentLib.Status.FULFILLED;
        solvers.reportOutcome(r.selectedSolver, true, notional);
        emit IntentFulfilled(intentId, r.selectedSolver, notional, feePaid);
    }

    function markFailed(bytes32 intentId, string calldata reason) external onlySettlement {
        IntentRecord storage r = _load(intentId);
        if (r.status != IntentLib.Status.SELECTED) revert BadStatus();
        address solver = r.selectedSolver;
        // The intent goes back to auction; the solver keeps the reputation hit.
        r.status = IntentLib.Status.OPEN;
        r.selectedSolver = address(0);
        r.selectedBid = 0;
        solvers.reportOutcome(solver, false, 0);
        emit IntentFailed(intentId, solver, reason);
    }

    // ----------------------------------------------------------------- views

    function getIntent(bytes32 intentId) external view returns (IntentRecord memory) {
        return _intents[intentId];
    }

    function getBid(bytes32 intentId, uint32 bidId) external view returns (Bid memory) {
        return _bids[intentId][bidId];
    }

    function bidCount(bytes32 intentId) external view returns (uint256) {
        return _bids[intentId].length;
    }

    function selectedBidOf(bytes32 intentId) external view returns (Bid memory) {
        IntentRecord storage r = _intents[intentId];
        return _bids[intentId][r.selectedBid];
    }

    function intentCount() external view returns (uint256) {
        return _intentIds.length;
    }

    function intentIdAt(uint256 index) external view returns (bytes32) {
        return _intentIds[index];
    }

    function intentsOf(address owner) external view returns (bytes32[] memory) {
        return _byOwner[owner];
    }

    /// @notice Canonical outcome/policy hashing, exposed so the SDK and solvers can verify
    ///         their offchain encoding against the chain's own.
    function hashOutcome(IntentLib.Outcome calldata outcome) external pure returns (bytes32) {
        return IntentLib.hashOutcome(outcome);
    }

    function hashPolicy(IntentLib.Policy calldata policy) external pure returns (bytes32) {
        return IntentLib.hashPolicy(policy);
    }

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("IntentOS");
    bytes32 private constant VERSION_HASH = keccak256("1");

    function _hashTypedDataV4(bytes32 structHash) private view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }

    function _load(bytes32 intentId) private view returns (IntentRecord storage r) {
        r = _intents[intentId];
        if (r.status == IntentLib.Status.NONE) revert UnknownIntent();
    }

    function _bid(bytes32 intentId, uint32 bidId) private view returns (Bid storage) {
        if (bidId >= _bids[intentId].length) revert UnknownBid();
        return _bids[intentId][bidId];
    }

    // ------------------------------------------------------------- governance

    function setSettlement(address settlement_) external onlyOwner {
        settlement = settlement_;
        emit SettlementSet(settlement_);
    }

    function setAuctioneer(address auctioneer_) external onlyOwner {
        auctioneer = auctioneer_;
        emit AuctioneerSet(auctioneer_);
    }

    function setChallengeRewardBps(uint16 bps) external onlyOwner {
        require(bps <= BPS, "bps");
        challengeRewardBps = bps;
    }

    /// @notice Top up the auctioneer bond that backs `challengeSelection`.
    function fundAuctioneerBond() external payable {
        auctioneerBond += msg.value;
    }

    function withdrawAuctioneerBond(uint256 amount, address to) external onlyOwner nonReentrant {
        require(amount <= auctioneerBond, "amount");
        auctioneerBond -= amount;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
