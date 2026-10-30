# Web3 Testnet Flow Specification & ADR (issue #14)

Specify Web3 testnet flow for NFTs, rentals (ERC-4907), and B2B settlement without migrating game economy on-chain.
Branch: `feat/issue-14-web3-spec` from `origin/main` (`d3caa7279ecea7104328a9c7c596f80dde84c518`) | Delivery: local work-unit commits, no push/PR/merge | Checks: `bun test`, `bun run lint`, `bun run build`.

## Specs

Source: GitHub issue #14 "[P2][Web3] Especificar flujo testnet para NFT, alquileres y liquidación sin mover economía a cadena".

- **S1** — ADR for Network/Testnet and NFT Standards: Evaluate L2 networks (Base Sepolia, Arbitrum Sepolia, Polygon Amoy) and NFT standards (ERC-721 for deeds, ERC-1155 for commodity lot receipts, ERC-4907 for dual-role rentals). Technical justification covering gas costs, L2 finality/reorg windows, and tooling compatibility.
- **S2** — Event Diagrams and State Machine: Full on-chain/off-chain state transition mapping for `CommodityLot`, `TradeEscrow`, and `UsageRight`. Visual sequence and state diagrams enforcing Strict Invariant 1 (Material Conservation) and Strict Invariant 2 (Ownership vs Usage separation).
- **S3** — Protection Architecture: Detailed design against double-spending (EIP-712 nonces + nullifiers), chain reorganizations (confirmation depth + rollback handling), repeated settlement (idempotent redeem + terminal statuses), and provider disconnection (reconciliation circuit breaker + fallback providers).
- **S4** — Credential Boundary Separation: Explicit isolation between MCP AI agent grants (read/write factory tools without private keys) and client-side Web3 wallet signing (EIP-712 vouchers and smart contract calls). Guarantee that zero MCP tools sign transactions or move tokens.
- **S5** — Economic and Regulatory Risk Analysis: Analysis of tokenomics risks: pay-to-win mitigation (lateral utility, contribution caps), botting/Sybil defenses (economic rate limits, cooldowns), and regulatory compliance (utility classification, no staking yield/rewards, testnet-only boundaries).
- **S6** — Parameterized Offline Test Suite: Specification test suite covering voucher creation, deposit, lease transfer, cancellation, and idempotent redeem with zero network calls, verifying no lot reuse or double credit.

## Product Questions (Open Decisions for Human Review)

1. **Confirmation Depth for Settlement**: Default recommended is 12 blocks on Base Sepolia (~24s) before releasing materials to buyer inventory off-chain. Question: Is 12 blocks acceptable for UX latency in B2B trades, or should instant optimistic credit with seller collateral slashing be supported?
2. **Rental Pricing Denomination**: Usage rights (ERC-4907 leases) currently specify duration in ticks with optional revenue share. Question: Should rental upfront fees be settled in off-chain factory Credits or on-chain testnet tokens?
3. **Receipt Expiration Window**: Default EIP-712 voucher validity is 3600 seconds (1 hour). Question: Should unminted vouchers expire after 1 hour, or should expiry be linked to match ticks/phases?

## Tasks

- **T1** [S1] — **done** — Write ADR for Network/Testnet and NFT Standards (`docs/research/adr-001-web3-testnet-and-nft-standards.md`). Evidence: Base Sepolia L2 selected; ERC-1155 (lots), ERC-721 (deeds), ERC-4907 (rentals) justified with comparative matrices.
- **T2** [S2,S3,S4,S5] — **done** — Write Web3 Testnet Flow Specification (`docs/backend/web3-testnet-flow-spec.md`). Evidence: Mermaid sequence and state diagrams, double-spending/reorg/repeated settlement defenses, credential separation, economic/regulatory risk mitigations.
- **T3** [S6] — **done** — Implement offline parameterized testnet flow test suite (`backend/tests/web3/testnet-settlement-flow.test.ts`). Evidence: 7 passed, 1 skipped (offline parameterized), 0 failed; proves material conservation, anti-replay, cancellation, ERC-4907 rental simulation, circuit breaker, and MCP boundary.
- **T4** [S1-S6] — **done** — Verification (`bun test`: 650 pass, 2 skip; `bun run lint`: 0 errors; `bun run build`: 0 errors), Engram persistence, and criteria report. Evidence: clean CI checks in worktree.
