// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// The token ID is the SHA-256 of the exact payload signed on capture.
contract Observation is ERC721 {
    address public immutable issuer;
    address public immutable rover;
    constructor(address roverIdentity) ERC721("ROVSSA Field Observations", "ROVOBS") {
        require(roverIdentity != address(0), "Missing rover");
        rover = roverIdentity;
        issuer = msg.sender;
    }

    function isRecorded(bytes32 digest) external view returns (bool) {
        return _ownerOf(uint256(digest)) != address(0);
    }

    function record(bytes32 digest, bytes calldata signature) external {
        require(msg.sender == issuer, "Issuer only");
        require(ECDSA.recover(digest, signature) == rover, "Invalid rover signature");
        _safeMint(msg.sender, uint256(digest));
    }
}
