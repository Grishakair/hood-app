// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DuelEscrow — draft, TESTNET-ONLY escrow for Last Dance matches
/// @notice NOT AUDITED. NOT DEPLOYED. Do not point this at mainnet or real
/// funds. This is a starting draft for the "how do we hold real money
/// without getting hacked" question flagged in the project notes — it needs
/// a security audit and a legal/regulatory review (this product is wagering
/// on trading skill, which several jurisdictions treat as gambling) before
/// any real value ever touches it. See docs/last-dance-custody-plan.md for
/// the reasoning, the trust model this implies, and what's still open.
///
/// Design in one paragraph: players deposit an equal stake into a match by
/// id; once every seat is filled, the match is locked. The off-chain
/// matchmaking server (server/duelServer.js) is the only party that knows
/// the live basket prices needed to determine a winner, so it acts as a
/// trusted "resolver" that submits the payout split once the round ends.
/// This is NOT a trustless design — the resolver key is a real target once
/// money is real (see the doc). Two safety valves exist so the resolver
/// can never simply keep the money: (1) it can only pay out exactly the
/// pot that was deposited, never more, and (2) if it goes offline or
/// misbehaves, any player can pull a full refund after a timeout.
contract DuelEscrow {
    struct Match {
        address[] players;
        uint256 stake; // per-player stake, in wei
        uint8 size; // expected player count (2 or 5 today)
        uint32 filledAt; // block.timestamp once the last seat filled; 0 until then
        bool resolved;
        bool refunded;
        mapping(address => bool) isPlayer;
        mapping(address => bool) claimed; // refund claimed, to prevent double-claiming
    }

    /// @dev Resolver has narrow, specific powers only (see resolveMatch) —
    /// it can never withdraw funds to itself or move more than the pot.
    address public resolver;
    address public owner;
    bool public paused;

    /// @dev Refund window: if the resolver hasn't resolved a filled match
    /// within this long, it's considered unresponsive/compromised and every
    /// player can pull their own stake back. Tune before real deployment —
    /// this only needs to comfortably exceed a normal match's duration
    /// (pick window + round length in duelServer.js).
    uint256 public constant RESOLUTION_TIMEOUT = 10 minutes;

    mapping(bytes32 => Match) private matches;

    event MatchJoined(bytes32 indexed matchId, address indexed player, uint256 stake, uint8 seatsFilled, uint8 size);
    event MatchLocked(bytes32 indexed matchId, uint256 pot);
    event MatchResolved(bytes32 indexed matchId, address[] winners, uint256[] payouts);
    event RefundClaimed(bytes32 indexed matchId, address indexed player, uint256 amount);
    event ResolverUpdated(address indexed newResolver);
    event Paused(bool isPaused);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyResolver() {
        require(msg.sender == resolver, "not resolver");
        _;
    }

    modifier notPaused() {
        require(!paused, "paused");
        _;
    }

    uint256 private locked = 1; // reentrancy guard, 1 = unlocked, 2 = locked
    modifier nonReentrant() {
        require(locked == 1, "reentrant");
        locked = 2;
        _;
        locked = 1;
    }

    constructor(address _resolver) {
        owner = msg.sender;
        resolver = _resolver;
    }

    function setResolver(address _resolver) external onlyOwner {
        resolver = _resolver;
        emit ResolverUpdated(_resolver);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    /// @notice Join (and implicitly create, on the first call for a given
    /// matchId) a match by depositing exactly `stake`. `matchId` should be
    /// derived off-chain from the duelServer.js lobby id so both sides agree
    /// on which on-chain match a given queue/lobby corresponds to.
    function joinMatch(bytes32 matchId, uint8 size, uint256 stake) external payable notPaused {
        require(size == 2 || size == 5, "unsupported size");
        require(msg.value == stake && stake > 0, "bad stake");
        Match storage m = matches[matchId];

        if (m.players.length == 0 && m.stake == 0) {
            // first joiner initializes the match's terms
            m.stake = stake;
            m.size = size;
        }
        require(m.stake == stake, "stake mismatch for this match");
        require(m.size == size, "size mismatch for this match");
        require(!m.isPlayer[msg.sender], "already joined");
        require(m.players.length < m.size, "match full");
        require(m.filledAt == 0, "match already locked");

        m.isPlayer[msg.sender] = true;
        m.players.push(msg.sender);
        emit MatchJoined(matchId, msg.sender, stake, uint8(m.players.length), m.size);

        if (m.players.length == m.size) {
            m.filledAt = uint32(block.timestamp);
            emit MatchLocked(matchId, m.stake * m.size);
        }
    }

    /// @notice Called once by the resolver after a round finishes, with the
    /// off-chain-computed payout split. Enforced on-chain: winners must be
    /// players in this exact match, every payout must be non-negative, and
    /// the sum must equal the deposited pot exactly (no skimming, no
    /// shortchanging — the resolver picks *who* gets paid what, never *how
    /// much total* leaves the contract).
    function resolveMatch(bytes32 matchId, address[] calldata winners, uint256[] calldata payouts)
        external
        onlyResolver
        nonReentrant
    {
        Match storage m = matches[matchId];
        require(m.filledAt != 0, "match not locked yet");
        require(!m.resolved && !m.refunded, "already settled");
        require(winners.length == payouts.length && winners.length > 0, "bad arrays");

        uint256 pot = m.stake * m.size;
        uint256 total = 0;
        for (uint256 i = 0; i < winners.length; i++) {
            require(m.isPlayer[winners[i]], "winner not in match");
            total += payouts[i];
        }
        require(total == pot, "payouts must exactly equal the pot");

        m.resolved = true; // effects before interactions
        for (uint256 i = 0; i < winners.length; i++) {
            if (payouts[i] > 0) {
                (bool ok, ) = payable(winners[i]).call{value: payouts[i]}("");
                require(ok, "payout transfer failed");
            }
        }
        emit MatchResolved(matchId, winners, payouts);
    }

    /// @notice Safety valve: if a filled match sits unresolved past
    /// RESOLUTION_TIMEOUT (resolver offline, bug, or worse), every player
    /// can pull their own stake back — no one but the depositor can claim
    /// their own refund, and each can only claim once.
    function claimRefund(bytes32 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        require(m.isPlayer[msg.sender], "not a player in this match");
        require(!m.resolved, "already resolved normally");
        require(m.filledAt != 0, "match never locked — nothing to refund");
        require(block.timestamp >= m.filledAt + RESOLUTION_TIMEOUT, "resolution window still open");
        require(!m.claimed[msg.sender], "already claimed");

        m.claimed[msg.sender] = true;
        m.refunded = true;
        (bool ok, ) = payable(msg.sender).call{value: m.stake}("");
        require(ok, "refund transfer failed");
        emit RefundClaimed(matchId, msg.sender, m.stake);
    }

    function getMatchPlayers(bytes32 matchId) external view returns (address[] memory) {
        return matches[matchId].players;
    }

    function getMatchInfo(bytes32 matchId)
        external
        view
        returns (uint256 stake, uint8 size, uint32 filledAt, bool resolved, bool refunded, uint256 seatsFilled)
    {
        Match storage m = matches[matchId];
        return (m.stake, m.size, m.filledAt, m.resolved, m.refunded, m.players.length);
    }
}
