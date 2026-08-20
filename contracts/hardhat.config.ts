import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import { subtask, type HardhatUserConfig } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } from "hardhat/builtin-tasks/task-names";

const SOLC_VERSION = "0.8.24";

// Compile with the solc build that ships in node_modules instead of fetching a native binary
// from binaries.soliditylang.org, so `npm ci && npm test` works on locked-down CI runners.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args: { solcVersion: string }, _hre, runSuper) => {
  if (args.solcVersion === SOLC_VERSION) {
    return {
      compilerPath: require.resolve("solc/soljson.js"),
      isSolcJs: true,
      version: args.solcVersion,
      longVersion: `soljson-v${args.solcVersion}`,
    };
  }
  return runSuper(args);
});

dotenv.config({ path: "../.env" });

const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: SOLC_VERSION,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: "http://127.0.0.1:8545" },
    // X Layer — OKX's zkEVM L2. Gas is paid in OKB.
    xlayerTestnet: {
      url: process.env.XLAYER_TESTNET_RPC ?? "https://testrpc.xlayer.tech",
      chainId: 195,
      accounts,
    },
    xlayerMainnet: {
      url: process.env.XLAYER_MAINNET_RPC ?? "https://rpc.xlayer.tech",
      chainId: 196,
      accounts,
    },
  },
  paths: { sources: "contracts", tests: "test", cache: "cache", artifacts: "artifacts" },
};

export default config;
