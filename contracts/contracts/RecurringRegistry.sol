// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title RecurringRegistry
/// @notice Standing jobs. The agent/coordinator re-declares when `nextRunAt` is due.
///         Recurrence is not enforced by settlement; this is the durable trigger list.
contract RecurringRegistry is Ownable {
    struct Job {
        address owner;
        uint64 everySeconds;
        uint32 maxRuns;
        uint32 runs;
        uint64 nextRunAt;
        bool active;
        string prompt;
    }

    address public coordinator;
    Job[] private _jobs;
    mapping(address => uint256[]) private _byOwner;

    event JobCreated(uint256 indexed id, address indexed owner, uint64 everySeconds, uint32 maxRuns);
    event JobCancelled(uint256 indexed id, address indexed owner);
    event JobRun(uint256 indexed id, uint32 runs, uint64 nextRunAt);
    event CoordinatorSet(address coordinator);

    error NotAuthorized();
    error BadJob();
    error NotDue();

    constructor(address owner_) Ownable(owner_) {}

    function setCoordinator(address coordinator_) external onlyOwner {
        coordinator = coordinator_;
        emit CoordinatorSet(coordinator_);
    }

    function create(uint64 everySeconds, uint32 maxRuns, string calldata prompt) external returns (uint256 id) {
        return _create(msg.sender, everySeconds, maxRuns, prompt);
    }

    /// @notice Coordinator-paid create, after the owner has authorized a session on IntentRegistry.
    function createFor(
        address owner,
        uint64 everySeconds,
        uint32 maxRuns,
        string calldata prompt
    ) external returns (uint256 id) {
        if (msg.sender != coordinator && msg.sender != owner) revert NotAuthorized();
        if (owner == address(0)) revert BadJob();
        return _create(owner, everySeconds, maxRuns, prompt);
    }

    function cancel(uint256 id) external {
        Job storage job = _job(id);
        if (msg.sender != job.owner && msg.sender != coordinator) revert NotAuthorized();
        job.active = false;
        emit JobCancelled(id, job.owner);
    }

    function markRun(uint256 id) external {
        Job storage job = _job(id);
        if (msg.sender != coordinator && msg.sender != job.owner) revert NotAuthorized();
        if (!job.active) revert BadJob();
        if (block.timestamp < job.nextRunAt) revert NotDue();
        if (job.maxRuns != 0 && job.runs >= job.maxRuns) revert BadJob();

        job.runs += 1;
        job.nextRunAt = uint64(block.timestamp) + job.everySeconds;
        if (job.maxRuns != 0 && job.runs >= job.maxRuns) job.active = false;
        emit JobRun(id, job.runs, job.nextRunAt);
    }

    function jobCount() external view returns (uint256) {
        return _jobs.length;
    }

    function jobAt(uint256 id) external view returns (Job memory) {
        return _job(id);
    }

    function jobsOf(address owner) external view returns (uint256[] memory) {
        return _byOwner[owner];
    }

    function dueIds(uint256 limit) external view returns (uint256[] memory ids) {
        uint256 cap = limit == 0 ? 20 : limit;
        ids = new uint256[](cap);
        uint256 n;
        for (uint256 i; i < _jobs.length && n < cap; i++) {
            Job storage job = _jobs[i];
            if (!job.active) continue;
            if (block.timestamp < job.nextRunAt) continue;
            if (job.maxRuns != 0 && job.runs >= job.maxRuns) continue;
            ids[n++] = i;
        }
        assembly {
            mstore(ids, n)
        }
    }

    function _create(
        address owner,
        uint64 everySeconds,
        uint32 maxRuns,
        string calldata prompt
    ) private returns (uint256 id) {
        if (everySeconds < 60) revert BadJob();
        id = _jobs.length;
        _jobs.push(
            Job({
                owner: owner,
                everySeconds: everySeconds,
                maxRuns: maxRuns,
                runs: 0,
                nextRunAt: uint64(block.timestamp) + everySeconds,
                active: true,
                prompt: prompt
            })
        );
        _byOwner[owner].push(id);
        emit JobCreated(id, owner, everySeconds, maxRuns);
    }

    function _job(uint256 id) private view returns (Job storage job) {
        if (id >= _jobs.length) revert BadJob();
        job = _jobs[id];
    }
}
