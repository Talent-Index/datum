// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * DatumRegistry
 *
 * The platform's public record of who is on it and what they did. Every
 * account has a managed address and a role; sellers, developers and
 * companies may only post a listing once their identity check has been
 * recorded here; and every action anyone takes is logged as a hash keyed to
 * their address.
 *
 * Only hashes and addresses live here. Names, phone numbers and identity
 * documents stay off chain, because there is no erasure remedy against a
 * blockchain and those are personal data. Anyone holding the original
 * record can prove it matches the hash; nobody can recover it from the hash.
 *
 * The platform is the sole writer. Wallets are custodial and the platform
 * pays the gas, so a writer-per-account model would only add key handling
 * without adding any independence.
 */
contract DatumRegistry {
    enum Role {
        None,
        Buyer,
        Seller,
        Developer,
        Company,
        Trustee
    }

    struct Account {
        Role role;
        bool kycVerified;
        bytes32 kycHash;
        uint64 registeredAt;
    }

    struct Listing {
        address owner;
        bytes32 contentHash;
        bool live;
        uint64 postedAt;
    }

    address public owner;
    mapping(address => Account) public accounts;
    mapping(bytes32 => Listing) public listings;
    uint256 public activityCount;

    event Registered(address indexed who, Role role, uint64 at);
    event KycSet(address indexed who, bool verified, bytes32 docHash, address indexed reviewer);
    event ListingPosted(bytes32 indexed id, address indexed listingOwner, bytes32 contentHash);
    event ListingStatus(bytes32 indexed id, bool live);
    event Activity(uint256 indexed seq, address indexed actor, bytes32 indexed kind, bytes32 payloadHash, uint64 at);

    error NotOwner();
    error AlreadyRegistered(address who);
    error NotRegistered(address who);
    error NotVerified(address who);
    error ListingExists(bytes32 id);
    error NoSuchListing(bytes32 id);
    error BadRole();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function register(address who, Role role) external onlyOwner {
        if (role == Role.None) revert BadRole();
        if (accounts[who].role != Role.None) revert AlreadyRegistered(who);
        accounts[who] = Account({role: role, kycVerified: false, kycHash: bytes32(0), registeredAt: uint64(block.timestamp)});
        emit Registered(who, role, uint64(block.timestamp));
    }

    /// A trustee's or the platform's verdict on an identity check. The hash
    /// commits to the reviewed submission; the reviewer is recorded so the
    /// verdict is attributable.
    function setKyc(address who, bool verified, bytes32 docHash, address reviewer) external onlyOwner {
        if (accounts[who].role == Role.None) revert NotRegistered(who);
        accounts[who].kycVerified = verified;
        accounts[who].kycHash = docHash;
        emit KycSet(who, verified, docHash, reviewer);
    }

    /// Listings are gated on a verified identity. A seller, developer or
    /// company that has not passed the check cannot advertise.
    function postListing(bytes32 id, address listingOwner, bytes32 contentHash) external onlyOwner {
        Account memory a = accounts[listingOwner];
        if (a.role == Role.None) revert NotRegistered(listingOwner);
        if (!a.kycVerified) revert NotVerified(listingOwner);
        if (a.role != Role.Seller && a.role != Role.Developer && a.role != Role.Company) revert BadRole();
        if (listings[id].owner != address(0)) revert ListingExists(id);
        listings[id] = Listing({owner: listingOwner, contentHash: contentHash, live: false, postedAt: uint64(block.timestamp)});
        emit ListingPosted(id, listingOwner, contentHash);
    }

    function setListingLive(bytes32 id, bool live) external onlyOwner {
        if (listings[id].owner == address(0)) revert NoSuchListing(id);
        listings[id].live = live;
        emit ListingStatus(id, live);
    }

    /// Anything else anyone did: a commitment, a deposit request, a
    /// photograph submission, an approval. The kind is a short label hashed
    /// off chain; the payload hash commits to the full record.
    function log(address actor, bytes32 kind, bytes32 payloadHash) external onlyOwner returns (uint256 seq) {
        seq = ++activityCount;
        emit Activity(seq, actor, kind, payloadHash, uint64(block.timestamp));
    }

    function isVerified(address who) external view returns (bool) {
        return accounts[who].kycVerified;
    }
}
