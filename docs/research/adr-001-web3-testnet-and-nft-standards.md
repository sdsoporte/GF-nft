# ADR 001: Web3 Testnet Selection and NFT Asset Standards

Lead with the answer: **Adopt Base Sepolia (EVM L2) as the primary testnet, ERC-1155 for Commodity Lot Receipts, ERC-721 for Facility Deeds, and ERC-4907 for dual-role Blueprint rentals, coordinated via EIP-712 typed vouchers.**

## Quick Path

1. **Target Network**: Base Sepolia (`chainId: 84532`) for testnet prototyping; zero mainnet deployments in this phase.
2. **Asset Taxonomy**:
   - `FacilityDeed` -> ERC-721 (unique physical infrastructure).
   - `CommodityLot` -> ERC-1155 (semi-fungible resource batches with batch transfer efficiency).
   - `BlueprintModifier` -> ERC-4907 (dual-role: owner retains custody, tenant receives time-bound `UsageRight`).
3. **Bridge Security**: Off-chain backend signs EIP-712 typed vouchers with monotonic nonces and expiration timestamps. Smart contracts enforce single-use nullifiers to eliminate replay and double spending.

---

## Context & Problem Statement

GigaForge v4.1 combines a high-frequency authoritative simulation engine (ticks, production lines, local recipes, discrete energy units) with a forward-looking Web3 roadmap for digital property rights, inter-factory supply agreements, and equipment leasing.

Attempting to execute factory ticks, resource consumption, or command queues on-chain fails immediately:
- A single 2,700-tick match produces hundreds of thousands of state mutations.
- Block intervals (even 1-2s L2 blocks) cannot synchronize with real-time simulation ticks.
- Gas fees would make standard gameplay economically infeasible.

Therefore, the game economy remains **strictly off-chain** (authoritative SQLite/in-memory engine), while Web3 infrastructure is reserved exclusively for:
1. High-value property deeds (factories).
2. Specialized technology licenses and rentals (blueprints).
3. B2B wholesale commodity lot receipts (`LotReceipt`).

This ADR defines the technical selection of the testnet network and the smart contract token standards.

---

## Decision Matrix: Network & Testnet

We evaluated candidate EVM-compatible testnets based on five critical criteria:
1. **EVM Equivalence & Tooling**: Standard Solidity 0.8.x, Foundry/Hardhat, viem/ethers.js.
2. **Finality & Block Time**: Latency for B2B escrow settlement and UI feedback.
3. **Transaction Cost**: Gas overhead for lot minting, transfers, and escrow locking.
4. **Account Abstraction & Wallet UX**: Native passkey/ERC-4337 support for seamless player onboarding.
5. **Ecosystem & Faucet Availability**: Reliable testnet infrastructure without faucet starvation.

| Candidate Testnet | Block Time | Est. ERC-1155 Mint Gas Cost | Finality / Reorg Risk | Account Abstraction Support | Faucet Reliability | Verdict |
|---|---|---|---|---|---|---|
| **Base Sepolia (L2 - OP Stack)** | **2.0s** | **< $0.001 (sub-cent)** | **Soft: 2s; L1 finalized: ~12-15m** | **Native Coinbase Smart Wallet (Passkeys / ERC-4337)** | **High (Cloudflare, QuickNode, Coinbase)** | **SELECTED (Primary)** |
| **Arbitrum Sepolia (L2 - Nitro)** | 0.25s | < $0.002 | Soft: 250ms; L1 finalized: ~15m | Biconomy / ZeroDev integrations | High (Alchemy, QuickNode) | **Viable Alternative** |
| **Polygon Amoy (PoS L1)** | 2.1s | < $0.005 | Reorgs observed up to 32+ blocks historically | Standard ERC-4337 | Medium | Rejected (PoS reorg depth risk) |
| **Ronin Saigon (Sidechain)** | 3.0s | Custom DPoS | Sidechain bridge dependency | Custom Ronin Wallet | Low (Gaming-restricted access) | Rejected (Vendor lock-in) |

### Technical Justification for Base Sepolia

1. **OP Stack Rollup Economics**: Post-EIP-4844 (blobs), Base transaction costs are typically below $0.001. This allows high-volume testnet validation of B2B lot packaging without depleting developer gas budgets.
2. **Deterministic 2-Second Block Time**: Aligns cleanly with simulation checkpoints (every 300 ticks = 30-60s in production cadences), minimizing player wait times during lot tokenization.
3. **Consumer-Grade Onboarding**: Base natively supports Coinbase Smart Wallet, allowing Web2-style passkey authentication (FaceID/TouchID) without requiring players to store seed phrases or install browser extensions.
4. **Developer Tooling Parity**: Full Foundry compatibility, instant RPC responses, and comprehensive block explorer support (BaseScan Sepolia).

---

## Decision Matrix: NFT & Token Standards

Different game assets possess fundamentally distinct economic and operational behaviors. A one-size-fits-all token standard creates either excessive gas overhead or architectural inflexibility.

```
                      +-----------------------------+
                      |     GigaForge Assets        |
                      +--------------+--------------+
                                     |
         +---------------------------+---------------------------+
         |                           |                           |
         v                           v                           v
+------------------+       +-------------------+       +-------------------+
|  Facility Deeds  |       |  Commodity Lots   |       | Blueprint Modifiers
|  (Unique Land)   |       | (Resource Batches)|       |  (Leases/Rentals) |
+--------+---------+       +---------+---------+       +---------+---------+
         |                           |                           |
         v                           v                           v
     ERC-721                     ERC-1155                    ERC-4907
(1:1 Non-Fungible)          (Multi-Token Batches)      (Dual-Role Owner/User)
```

### 1. Commodity Lots -> ERC-1155 (Multi-Token Standard)

- **Problem**: When a factory packs 1,000 units of `STEEL_PLATE` or 50 `IND_TURBINE` into a trade lot, minting an individual ERC-721 per resource unit would cost prohibitive gas and bloat the blockchain state.
- **Why ERC-1155**:
  - **Batch Operations**: A single `balanceOfBatch` or `safeBatchTransferFrom` can transfer multiple resource lots in one transaction.
  - **Semi-Fungible IDs**: Each token ID corresponds to a specific catalog item type (`itemId`), with an associated batch/lot identifier encoded in the metadata or structured URI.
  - **Low Overhead**: Transfers use ~30% less gas than comparable ERC-721 operations.

### 2. Facility Deeds -> ERC-721 (Non-Fungible Token Standard)

- **Problem**: Industrial facilities (e.g., "Arc Furnace Complex Alpha", "Deep Mining Shaft 04") have distinct physical locations, historical output stats, and individual serial identifiers.
- **Why ERC-721**:
  - Global uniqueness: Exactly one company owns a specific facility deed.
  - Full compatibility with existing marketplace indexers (OpenSea, Blur testnets) for secondary market auctions.

### 3. Blueprint Modifiers -> ERC-4907 (Dual-Role Rental NFT Standard)

- **Problem**: Advanced manufacturing blueprints (e.g., "High-Efficiency Silicon Smelter V2") are capital-intensive. Guilds and specialized players want to lease these blueprints to smaller factories for revenue share or flat fees without relinquishing ownership custody.
  - If using standard ERC-721 transfers, the lessee can steal the NFT or default on return.
  - If using custodial staking escrows, gas costs are doubled on deposit and withdraw.
- **Why ERC-4907**:
  - ERC-4907 introduces `setUser(uint256 tokenId, address user, uint64 expires)`.
  - Distinguishes **Owner** (`ownerOf`) from **User** (`userOf`).
  - When `block.timestamp >= expires`, `userOf(tokenId)` automatically reverts to `address(0)` without requiring an on-chain transaction.
  - In GigaForge, this maps 1:1 to `UsageRight`:
    ```ts
    // Engine checks usage rights deterministically:
    const activeUsage = usageRight.beneficiaryCompanyId === companyId 
      && currentTick <= usageRight.expiresAtTick;
    ```

---

## EIP-712 Typed Structured Data for Off-Chain Vouchers

To prevent unauthorized minting or cross-chain replay attacks, off-chain lot receipts require cryptographic signatures conforming to **EIP-712**.

### Domain Separator

```solidity
bytes32 private constant DOMAIN_TYPEHASH = keccak256(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
);
```

| Field | Value | Rationale |
|---|---|---|
| `name` | `"GigaForge Settlement"` | Identifies the protocol |
| `version` | `"1"` | Upgradable across contract releases |
| `chainId` | `84532` (Base Sepolia) | Rejects replay on Ethereum Mainnet, Arbitrum, etc. |
| `verifyingContract` | Deployed `TradeEscrow1155` address | Rejects replay across different contract deployments |

### Voucher Struct TypeHash

```solidity
bytes32 private constant LOT_VOUCHER_TYPEHASH = keccak256(
    "LotVoucher(string lotId,string originCompanyId,string itemId,uint256 quantity,uint256 nonce,uint256 expirationTimestamp)"
);
```

- `nonce`: Monotonically increasing counter stored in `account_nonces` (SQLite) and tracked on-chain in `mapping(address => uint256) public userNonces`.
- `expirationTimestamp`: Hard deadline (e.g., `currentTime + 3600s`). After expiration, the voucher is invalid, allowing the seller to revert off-chain inventory without on-chain interaction.

---

## Consequences & Tradeoffs

| Category | Outcome |
|---|---|
| **Simulation Speed** | Engine simulation loop remains unaffected (running at 1,000+ ticks/sec off-chain). |
| **Material Integrity** | Strict Invariant 1 (Material Conservation) is preserved via two-phase lock in SQLite. |
| **Security** | Replay attacks and double claims are rendered cryptographically impossible via EIP-712 nullifiers. |
| **Gas Costs** | ERC-1155 and Base Sepolia keep testnet execution gas virtually zero. |
| **L2 Reorg Boundary** | Requires a 12-block confirmation window (~24s) before releasing unpacked materials off-chain. |

---

## Checklist for Reviewers

- [x] Base Sepolia selected with technical rationale (OP Stack, sub-cent gas, 2s block time).
- [x] ERC-1155, ERC-721, and ERC-4907 selected with clear asset boundary mappings.
- [x] EIP-712 domain separator and struct hashing fully specified.
- [x] Zero mainnet deployment or real financial value promises in this phase.
