import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const {
  RH_RPC_URL,
  RH_CHAIN_ID,
  DEPLOYER_PRIVATE_KEY,
} = process.env;

/**
 * The signing key is read from the environment and nowhere else.
 *
 * Never paste a private key into a chat window, a commit, or a shell command
 * (shell history persists it). `.env` is gitignored at the repo root.
 *
 * Preferred, in order:
 *   1. A hardware wallet, or an encrypted keystore (`cast wallet import agora`)
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
    hardhat: {},
    localhost: { url: "http://127.0.0.1:8545" },
    robinhood: {
      url: RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
      chainId: RH_CHAIN_ID ? Number(RH_CHAIN_ID) : 4663,
      accounts,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
