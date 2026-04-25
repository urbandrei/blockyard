// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title  Blockyard LevelRegistry
/// @notice Minimal ERC-721 used as a proof-of-authorship registry for
///         user-submitted Blockyard levels. Anyone can mint; the caller is
///         recorded as the token owner. tokenURI points at the off-chain
///         metadata served by the Blockyard community server.
///
///         Scope per REQUIREMENTS.md §"Blockchain Integration":
///         - Testnet only (Base Sepolia, chainId 84532).
///         - No transfer restrictions, no royalties, no admin.
///         - Off-chain JSON is the source of truth for level data; the chain
///           only records "who minted what tokenURI."
contract LevelRegistry is ERC721 {
    uint256 private _nextId;
    mapping(uint256 => string) private _tokenURIs;

    /// @notice Emitted in addition to ERC-721 Transfer so indexers can pick
    ///         up the tokenURI without an extra read.
    event LevelMinted(uint256 indexed tokenId, address indexed owner, string tokenURI);

    constructor() ERC721("Blockyard Level", "BYL") {
        // tokenId 0 is reserved so a freshly-minted id of 1 is unambiguous
        // when callers parse the Transfer event.
        _nextId = 1;
    }

    /// @notice Mint a new Level NFT to msg.sender with the given tokenURI.
    /// @param uri  https://<api>/levels/<id>/metadata.json — the metadata
    ///             document follows the OpenSea-compatible ERC-721 metadata
    ///             schema (name, description, image, external_url).
    /// @return tokenId The newly minted token id.
    function mint(string calldata uri) external returns (uint256) {
        uint256 tokenId = _nextId++;
        _safeMint(msg.sender, tokenId);
        _tokenURIs[tokenId] = uri;
        emit LevelMinted(tokenId, msg.sender, uri);
        return tokenId;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _tokenURIs[tokenId];
    }
}
