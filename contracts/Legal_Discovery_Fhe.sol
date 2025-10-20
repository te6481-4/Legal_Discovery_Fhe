pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract LegalDiscoveryFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        uint256 id;
        bool open;
    }
    uint256 public currentBatchId;
    mapping(uint256 => Batch) public batches;

    struct Document {
        euint32 encryptedId;
        euint32 encryptedContent;
    }
    mapping(uint256 => Document[]) public batchDocuments;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSecondsChanged(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event DocumentSubmitted(address indexed provider, uint256 indexed batchId, euint32 encryptedId);
    event KeywordSearchRequested(uint256 indexed requestId, uint256 indexed batchId, euint32 encryptedKeyword);
    event KeywordSearchCompleted(uint256 indexed requestId, uint256 batchId, uint256 count);

    error NotOwner();
    error NotProvider();
    error PausedContract();
    error CooldownActive();
    error BatchClosedOrInvalid();
    error InvalidBatchId();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedContract();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[msg.sender] = true;
        emit ProviderAdded(msg.sender);
        currentBatchId = 1; // Start with batch 1
        _openBatch(currentBatchId);
        cooldownSeconds = 30; // Default cooldown
    }

    function transferOwnership(address newOwner) public onlyOwner {
        require(newOwner != address(0), "New owner is zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) public onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) public onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() public onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() public onlyOwner {
        require(paused, "Contract not paused");
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) public onlyOwner {
        require(newCooldownSeconds > 0, "Cooldown must be positive");
        emit CooldownSecondsChanged(cooldownSeconds, newCooldownSeconds);
        cooldownSeconds = newCooldownSeconds;
    }

    function openNewBatch() public onlyOwner whenNotPaused {
        currentBatchId++;
        _openBatch(currentBatchId);
    }

    function closeCurrentBatch() public onlyOwner whenNotPaused {
        if (batches[currentBatchId].open) {
            batches[currentBatchId].open = false;
            emit BatchClosed(currentBatchId);
        }
    }

    function submitDocument(
        euint32 encryptedId,
        euint32 encryptedContent
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        _initIfNeeded(encryptedId);
        _initIfNeeded(encryptedContent);

        if (!batches[currentBatchId].open) {
            revert BatchClosedOrInvalid();
        }

        batchDocuments[currentBatchId].push(Document(encryptedId, encryptedContent));
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit DocumentSubmitted(msg.sender, currentBatchId, encryptedId);
    }

    function searchKeywordInBatch(
        uint256 batchId,
        euint32 encryptedKeyword
    ) external onlyProvider whenNotPaused checkDecryptionCooldown {
        _initIfNeeded(encryptedKeyword);

        if (batchId == 0 || batchId > currentBatchId || !batches[batchId].open) {
            revert InvalidBatchId();
        }
        if (batchDocuments[batchId].length == 0) {
            revert("No documents in batch"); // Specific error for empty batch
        }

        euint32 encryptedCount = FHE.asEuint32(0);
        for (uint i = 0; i < batchDocuments[batchId].length; i++) {
            ebool isMatch = batchDocuments[batchId][i].encryptedContent.eq(encryptedKeyword);
            euint32 matchAsUint = isMatch ? FHE.asEuint32(1) : FHE.asEuint32(0);
            encryptedCount = encryptedCount.add(matchAsUint);
        }

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = encryptedCount.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false
        });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit KeywordSearchRequested(requestId, batchId, encryptedKeyword);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) {
            revert ReplayAttempt();
        }

        // State Verification
        bytes32[] memory cts = new bytes32[](1);
        // Rebuild cts from storage: this requires re-calculating the encrypted count
        // as it was at the time of requestDecryption.
        // This simplified example assumes the encryptedCount is directly available or reconstructible.
        // For complex state, this step would involve re-running the FHE computation.
        // Here, we'll assume the state hash stored in decryptionContexts[requestId].stateHash
        // is the ground truth for what the state *should* be.
        // A more robust implementation would re-calculate the encryptedCount from scratch
        // using current contract storage and compare its hash.
        // For this example, we'll use the stored stateHash directly for comparison.
        // This implies that the state (encryptedCount) is not expected to change
        // between requestDecryption and myCallback for the same requestId.
        // If it could change, the re-calculation logic would be more complex.
        // The critical check is:
        if (decryptionContexts[requestId].stateHash != keccak256(abi.encode(cts, address(this)))) {
             revert StateMismatch();
        }

        // Proof Verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        // Decode & Finalize
        uint256 count = abi.decode(cleartexts, (uint256));
        decryptionContexts[requestId].processed = true;
        emit KeywordSearchCompleted(requestId, decryptionContexts[requestId].batchId, count);
    }

    function _openBatch(uint256 batchId) internal {
        batches[batchId] = Batch({ id: batchId, open: true });
        emit BatchOpened(batchId);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 val) internal {
        if (!val.isInitialized()) {
            revert NotInitialized();
        }
    }

    function _initIfNeeded(ebool val) internal {
        if (!val.isInitialized()) {
            revert NotInitialized();
        }
    }
}