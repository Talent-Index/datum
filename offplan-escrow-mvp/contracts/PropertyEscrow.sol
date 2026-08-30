// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * PropertyEscrow
 *
 * Holds off-plan buyer deposits for one development and releases them to the
 * developer only when a construction milestone has been attested by at least
 * two of three independent parties.
 *
 * Denominated in a KES-pegged token, never in a volatile native asset. In
 * production the token is a mirror of a segregated bank escrow account; the
 * chain is the claim ledger and the release authorisation, not the custodian.
 *
 * Design notes on the two things that most often go wrong:
 *
 *  - Release amounts are computed from a CUMULATIVE percentage against the
 *    current pool, not a flat percentage of a moving total. Off-plan buyers
 *    join throughout construction, so a naive `total * pct / 100` per
 *    milestone will over- or under-release. See _tryRelease.
 *
 *  - Refunds are paid pro rata from a pool SNAPSHOT taken at the moment the
 *    project is declared stalled. Computing against the live balance lets the
 *    first claimant take a full refund and leaves later buyers short.
 */
contract PropertyEscrow {
    // ─── Roles ────────────────────────────────────────────────────────────
    // Three independent attesters. Any two can advance a milestone, so no
    // single party — including the platform — can block or force a release.
    uint8 public constant ORACLE = 0; // computer-vision evidence pipeline
    uint8 public constant SURVEYOR = 1; // licensed quantity surveyor
    uint8 public constant PLATFORM = 2; // the escrow operator
    uint8 public constant THRESHOLD = 2;

    address[3] public attesters;
    address public developer;
    IERC20 public immutable token;

    // ─── Project state ────────────────────────────────────────────────────
    enum Status {
        Active,
        Stalled,
        Completed
    }
    Status public status;

    uint256 public totalDeposited;
    uint256 public totalReleased;
    uint256 public refundPool; // snapshot taken when the project stalls
    uint256 public lastProgressAt; // last deposit or release
    uint256 public immutable stallAfter; // seconds of silence before anyone can stall it

    struct Milestone {
        string description;
        uint8 releasePercent; // share of the total pool this milestone unlocks
        uint8 cumulativePercent; // running total, filled in at construction
        bytes32 evidenceHash; // hash of the geotagged image bundle + report
        uint8 approvals;
        bool released;
    }

    Milestone[] public milestones;
    uint256 public nextMilestone; // milestones complete in order

    mapping(uint256 => mapping(uint8 => bool)) public hasAttested;
    mapping(address => uint256) public deposited;
    mapping(address => bool) public refunded;
    address[] public buyers;

    // ─── Events ───────────────────────────────────────────────────────────
    event Deposited(address indexed buyer, uint256 amount, uint256 newTotal);
    event Attested(uint256 indexed milestoneId, uint8 role, bytes32 evidenceHash);
    event Released(uint256 indexed milestoneId, uint256 amount, bytes32 evidenceHash);
    event Stalled(uint256 refundPool, uint256 at);
    event Refunded(address indexed buyer, uint256 amount);
    event Completed(uint256 at);

    error NotActive();
    error NotAttester();
    error AlreadyAttested();
    error NothingToRefund();
    error TransferFailed();

    modifier onlyActive() {
        if (status != Status.Active) revert NotActive();
        _;
    }

    constructor(
        address _token,
        address _developer,
        address[3] memory _attesters,
        string[] memory descriptions,
        uint8[] memory percents,
        uint256 _stallAfter
    ) {
        require(descriptions.length == percents.length, "length mismatch");
        require(descriptions.length > 0, "no milestones");

        token = IERC20(_token);
        developer = _developer;
        attesters = _attesters;
        stallAfter = _stallAfter;
        status = Status.Active;
        lastProgressAt = block.timestamp;

        uint8 running = 0;
        for (uint256 i = 0; i < descriptions.length; i++) {
            running += percents[i];
            milestones.push(
                Milestone({
                    description: descriptions[i],
                    releasePercent: percents[i],
                    cumulativePercent: running,
                    evidenceHash: bytes32(0),
                    approvals: 0,
                    released: false
                })
            );
        }
        require(running == 100, "percents must sum to 100");
    }

    // ─── Buyers ───────────────────────────────────────────────────────────

    /// Deposit is pulled from the platform's settlement wallet on the buyer's
    /// behalf. The buyer never signs anything and never holds a key.
    function depositFor(address buyer, uint256 amount) external onlyActive {
        require(amount > 0, "zero deposit");
        if (deposited[buyer] == 0) buyers.push(buyer);
        deposited[buyer] += amount;
        totalDeposited += amount;
        lastProgressAt = block.timestamp;

        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Deposited(buyer, amount, totalDeposited);
    }

    // ─── Attestation ──────────────────────────────────────────────────────

    /// Any two of the three attesters advance the current milestone. The
    /// evidence hash of the first attester is the one recorded.
    function attest(uint256 milestoneId, uint8 role, bytes32 evidenceHash) external onlyActive {
        if (role > PLATFORM || msg.sender != attesters[role]) revert NotAttester();
        require(milestoneId == nextMilestone, "milestones complete in order");
        if (hasAttested[milestoneId][role]) revert AlreadyAttested();

        Milestone storage m = milestones[milestoneId];
        require(!m.released, "already released");

        hasAttested[milestoneId][role] = true;
        m.approvals += 1;
        if (m.evidenceHash == bytes32(0)) m.evidenceHash = evidenceHash;

        emit Attested(milestoneId, role, evidenceHash);

        if (m.approvals >= THRESHOLD) _release(milestoneId);
    }

    /**
     * Release the cumulative entitlement, not a flat slice.
     *
     * owed = totalDeposited * cumulativePercent / 100 - totalReleased
     *
     * A buyer who joins at milestone 3 of 5 has their share for milestones
     * 1-3 released at the next event, which is correct: they bought into a
     * building that is already 60% up.
     */
    function _release(uint256 milestoneId) internal {
        Milestone storage m = milestones[milestoneId];
        m.released = true;
        nextMilestone = milestoneId + 1;
        lastProgressAt = block.timestamp;

        uint256 target = (totalDeposited * m.cumulativePercent) / 100;
        uint256 owed = target > totalReleased ? target - totalReleased : 0;
        totalReleased += owed;

        if (owed > 0 && !token.transfer(developer, owed)) revert TransferFailed();
        emit Released(milestoneId, owed, m.evidenceHash);

        if (nextMilestone == milestones.length) {
            status = Status.Completed;
            emit Completed(block.timestamp);
        }
    }

    // ─── Stall and refund ─────────────────────────────────────────────────

    /**
     * Anyone can stall the project once it has gone quiet for `stallAfter`.
     * This is deliberate: if the platform disappears or sides with the
     * developer, buyers must still be able to reach their money.
     */
    function declareStalled() external onlyActive {
        bool timedOut = block.timestamp >= lastProgressAt + stallAfter;
        bool byPlatform = msg.sender == attesters[PLATFORM];
        require(timedOut || byPlatform, "not stalled yet");

        status = Status.Stalled;
        refundPool = token.balanceOf(address(this)); // snapshot
        emit Stalled(refundPool, block.timestamp);
    }

    /// Pro rata against the snapshot, so claim order does not matter.
    function claimRefund(address buyer) external {
        require(status == Status.Stalled, "not stalled");
        if (deposited[buyer] == 0 || refunded[buyer]) revert NothingToRefund();

        refunded[buyer] = true;
        uint256 amount = (refundPool * deposited[buyer]) / totalDeposited;

        if (amount > 0 && !token.transfer(buyer, amount)) revert TransferFailed();
        emit Refunded(buyer, amount);
    }

    // ─── Views ────────────────────────────────────────────────────────────

    function heldBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function milestoneCount() external view returns (uint256) {
        return milestones.length;
    }

    function buyerCount() external view returns (uint256) {
        return buyers.length;
    }

    /// What a buyer sees in the app: what they put in, what has gone to the
    /// developer against verified work, and what is still protected.
    function buyerPosition(address buyer)
        external
        view
        returns (uint256 contributed, uint256 releasedOnTheirBehalf, uint256 stillHeld)
    {
        contributed = deposited[buyer];
        if (totalDeposited == 0) return (0, 0, 0);
        releasedOnTheirBehalf = (totalReleased * contributed) / totalDeposited;
        stillHeld = contributed - releasedOnTheirBehalf;
    }
}
