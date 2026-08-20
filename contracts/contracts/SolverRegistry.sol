// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SolverRegistry
/// @notice Registration, bonding and onchain reputation for the IntentOS solver network.
/// @dev Reputation is an exponential moving average in basis points, seeded at `SEED_SCORE`
///      so a brand new solver is neither trusted nor unusable. Only contracts marked as
///      reporters (the settlement contract, the intent registry) may move a score.
contract SolverRegistry is Ownable, ReentrancyGuard {
    struct Solver {
        bool registered;
        uint64 registeredAt;
        uint256 bond; // slashable stake, denominated in the chain's native token
        uint16 reputationBps; // EMA of settlement outcomes
        uint32 fulfilled;
        uint32 failed;
        uint256 notionalSettled; // cumulative input notional routed, for leaderboards
        string metadataURI; // solver capabilities / contact, off-chain
    }

    uint16 public constant BPS = 10_000;
    uint16 public constant SEED_SCORE = 5_000;
    /// @notice Weight of the newest outcome in the EMA, in bps. 2000 => ~5 intent half-life.
    uint16 public constant EMA_ALPHA_BPS = 2_000;

    uint256 public minBond;
    /// @notice Cool-down between requesting an unbond and being able to withdraw it.
    uint256 public unbondDelay = 3 days;

    mapping(address => Solver) private _solvers;
    mapping(address => uint256) public unbondReadyAt;
    mapping(address => bool) public isReporter;
    address[] private _solverList;

    event SolverRegistered(address indexed solver, uint256 bond, string metadataURI);
    event SolverBonded(address indexed solver, uint256 amount, uint256 total);
    event UnbondRequested(address indexed solver, uint256 readyAt);
    event SolverUnbonded(address indexed solver, uint256 amount);
    event OutcomeReported(address indexed solver, bool success, uint16 reputationBps, uint256 notional);
    event SolverSlashed(address indexed solver, uint256 amount, address indexed recipient, string reason);
    event ReporterSet(address indexed reporter, bool allowed);
    event MetadataUpdated(address indexed solver, string metadataURI);

    error NotRegistered();
    error AlreadyRegistered();
    error BondTooSmall();
    error NotReporter();
    error UnbondNotReady();
    error NothingToUnbond();
    error TransferFailed();

    modifier onlyReporter() {
        if (!isReporter[msg.sender]) revert NotReporter();
        _;
    }

    constructor(address owner_, uint256 minBond_) Ownable(owner_) {
        minBond = minBond_;
    }

    // --------------------------------------------------------------- solvers

    function register(string calldata metadataURI) external payable {
        Solver storage s = _solvers[msg.sender];
        if (s.registered) revert AlreadyRegistered();
        if (msg.value < minBond) revert BondTooSmall();

        s.registered = true;
        s.registeredAt = uint64(block.timestamp);
        s.bond = msg.value;
        s.reputationBps = SEED_SCORE;
        s.metadataURI = metadataURI;
        _solverList.push(msg.sender);

        emit SolverRegistered(msg.sender, msg.value, metadataURI);
    }

    function addBond() external payable {
        Solver storage s = _solvers[msg.sender];
        if (!s.registered) revert NotRegistered();
        s.bond += msg.value;
        emit SolverBonded(msg.sender, msg.value, s.bond);
    }

    function setMetadata(string calldata metadataURI) external {
        Solver storage s = _solvers[msg.sender];
        if (!s.registered) revert NotRegistered();
        s.metadataURI = metadataURI;
        emit MetadataUpdated(msg.sender, metadataURI);
    }

    /// @notice Start the unbonding cool-down. The bond stays slashable until withdrawn.
    function requestUnbond() external {
        if (!_solvers[msg.sender].registered) revert NotRegistered();
        uint256 readyAt = block.timestamp + unbondDelay;
        unbondReadyAt[msg.sender] = readyAt;
        emit UnbondRequested(msg.sender, readyAt);
    }

    /// @notice Withdraw the bond down to `minBond`, or all of it while giving up registration.
    function unbond(uint256 amount) external nonReentrant {
        Solver storage s = _solvers[msg.sender];
        if (!s.registered) revert NotRegistered();
        uint256 readyAt = unbondReadyAt[msg.sender];
        if (readyAt == 0 || block.timestamp < readyAt) revert UnbondNotReady();
        if (amount == 0 || amount > s.bond) revert NothingToUnbond();

        s.bond -= amount;
        unbondReadyAt[msg.sender] = 0;
        if (s.bond < minBond) {
            s.registered = false;
        }

        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit SolverUnbonded(msg.sender, amount);
    }

    // -------------------------------------------------------------- reporting

    /// @notice Record a settlement outcome and move the solver's EMA reputation.
    function reportOutcome(address solver, bool success, uint256 notional) external onlyReporter {
        Solver storage s = _solvers[solver];
        if (!s.registered) revert NotRegistered();

        uint16 target = success ? BPS : 0;
        s.reputationBps = uint16(
            (uint256(s.reputationBps) * (BPS - EMA_ALPHA_BPS) + uint256(target) * EMA_ALPHA_BPS) / BPS
        );
        if (success) {
            s.fulfilled += 1;
            s.notionalSettled += notional;
        } else {
            s.failed += 1;
        }

        emit OutcomeReported(solver, success, s.reputationBps, notional);
    }

    /// @notice Slash a bonded solver. Used for failed-after-selection and dominated-bid cases.
    function slash(address solver, uint256 amount, address recipient, string calldata reason)
        external
        onlyReporter
        nonReentrant
    {
        Solver storage s = _solvers[solver];
        uint256 take = amount > s.bond ? s.bond : amount;
        if (take == 0) return;
        s.bond -= take;
        if (s.bond < minBond) {
            s.registered = false;
        }
        (bool ok, ) = recipient.call{value: take}("");
        if (!ok) revert TransferFailed();
        emit SolverSlashed(solver, take, recipient, reason);
    }

    // ----------------------------------------------------------------- views

    function getSolver(address solver) external view returns (Solver memory) {
        return _solvers[solver];
    }

    function reputationOf(address solver) external view returns (uint16) {
        return _solvers[solver].reputationBps;
    }

    function isActive(address solver) external view returns (bool) {
        Solver storage s = _solvers[solver];
        return s.registered && s.bond >= minBond;
    }

    function solverCount() external view returns (uint256) {
        return _solverList.length;
    }

    function solverAt(uint256 index) external view returns (address) {
        return _solverList[index];
    }

    // ------------------------------------------------------------- governance

    function setReporter(address reporter, bool allowed) external onlyOwner {
        isReporter[reporter] = allowed;
        emit ReporterSet(reporter, allowed);
    }

    function setMinBond(uint256 newMinBond) external onlyOwner {
        minBond = newMinBond;
    }

    function setUnbondDelay(uint256 newDelay) external onlyOwner {
        unbondDelay = newDelay;
    }
}
