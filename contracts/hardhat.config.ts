import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const {
  RH_RPC_URL,
  RH_CHAIN_ID,
  BSC_RPC_URL,
  BSC_TESTNET_RPC_URL,
  DEPLOYER_PRIVATE_KEY,
  ETHERSCAN_API_KEY,
} = process.env;

/**
 * The signing key is read from the environment and nowhere else.
 *
 * Never paste a private key into a chat window, a commit, or a shell command
 * (shell history persists it). `.env` is gitignored at the repo root.
 *
 * Preferred, in order:
 *   1. A hardware wallet, or an encrypted keystore (`cast wallet import torii`)
 *      with a one-off signing step.
 *   2. A freshly generated deploy-only key funded with just enough gas, kept in
 *      `.env`, and treated as disposable after deployment. Nothing in these
 *      contracts requires the deployer to retain power — ownership is handed to
 *      TREASURY_OWNER at construction time.
 */
const accounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // The Treasury is meant to be read and audited, not just executed.
      metadata: { bytecodeHash: "none" },
    },
  },
  networks: {
    /**
     * `FORK=1` points the in-process node at Robinhood Chain, so the Beefy
     * adapter can be exercised against the **real** CLM vault, reward pool and
     * Uniswap v3 pool rather than mocks. Pin a block with `FORK_BLOCK` for a
     * reproducible run; leave it unset to track the chain head.
     *
     * Mocks cannot answer the questions that matter here — whether Beefy's
     * `isCalm()` gate passes, whether the in-ratio split actually mints shares,
     * how much the pool's own fee eats. Only the live state can.
     */
    /**
     * `BNB_TEST=1` runs the in-process node as chain 56.
     *
     * This is not cosmetic. Flap's `VaultBase` resolves the Portal and Guardian
     * from `block.chainid` against a hardcoded table (56 / 97 / 4663) and
     * reverts `UnsupportedChain` on anything else — including Hardhat's default
     * 31337. Without this, every Guardian-gated test fails for the wrong reason.
     */
    hardhat: process.env.BNB_TEST
      ? { chainId: 56 }
      : process.env.FORK
      ? {
          forking: {
            url: RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
            blockNumber: process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : undefined,
          },
          chainId: 4663,
          // Chain 4663 is not in Hardhat's built-in table, so its hardfork
          // history has to be declared or every historical call reverts with
          // "No known hardfork for execution on historical block".
          chains: {
            4663: { hardforkHistory: { shanghai: 0 } },
          },
        }
      : {},
    localhost: { url: "http://127.0.0.1:8545" },
    /**
     * A `npx hardhat node --fork <RH_RPC_URL> --port 8546` instance.
     * `scripts/rehearse-beefy.ts` drives the adapter against real Beefy state
     * here — see that script's header for why mocks were not enough.
     */
    forked: { url: "http://127.0.0.1:8546" },
    robinhood: {
      url: RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
      chainId: RH_CHAIN_ID ? Number(RH_CHAIN_ID) : 4663,
      accounts,
    },
    /**
     * BNB Chain. The TORII deployment here is NOT a port of the Robinhood Chain
     * one: there is no Pons, so the tax comes from Flap instead, `FeeSink` is
     * replaced by `bnb/ToriiVault`, the rate is 5% rather than 4% (Flap offers
     * 1/3/5/10% only), and the Suits vault is dropped entirely because that
     * collection has no BNB deployment.
     *
     * Test on `bscTestnet` first. Flap's Portal, Guardian and vault addresses
     * are all chain-keyed inside `flap/VaultBase.sol`, so chain 97 exercises the
     * same code paths as 56 without mainnet BNB at risk.
     */
    bsc: {
      url: BSC_RPC_URL || "https://bsc-dataseed.bnbchain.org",
      chainId: 56,
      accounts,
    },
    bscTestnet: {
      url: BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
      chainId: 97,
      accounts,
    },
  },
  /**
   * Block-explorer source verification.
   *
   * One Etherscan V2 key covers BscScan as well — the V2 API is multichain and
   * routes by chainId, so there is no separate BscScan key to manage. Get one at
   * etherscan.io/apidashboard and put it in .env as ETHERSCAN_API_KEY.
   *
   * Verification matters more than usual here: this is a public reserve holding
   * other people's money, and the whole argument for trusting it — immutable
   * destinations, no privileged caller on the distributor, a launch guard that
   * cannot be bypassed — is only checkable if the source is on the explorer.
   * Unverified bytecode asks people to take that on faith.
   *
   * Robinhood Chain runs Blockscout, which takes no API key; `apiKey` is ignored
   * for that entry and the URLs are what matter.
   */
  etherscan: {
    apiKey: {
      bsc: ETHERSCAN_API_KEY ?? "",
      bscTestnet: ETHERSCAN_API_KEY ?? "",
      robinhood: "blockscout-needs-no-key",
    },
    customChains: [
      {
        network: "robinhood",
        chainId: 4663,
        urls: {
          apiURL: "https://robinhoodchain.blockscout.com/api",
          browserURL: "https://robinhoodchain.blockscout.com",
        },
      },
    ],
  },
  sourcify: { enabled: false },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
