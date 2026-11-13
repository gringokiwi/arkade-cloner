// Local EVM for the integration tests. FORK_URL turns it into a fork of Base mainnet.
const fork = process.env.FORK_URL
module.exports = {
  paths: { root: __dirname + "/..", cache: __dirname + "/../node_modules/.cache/hardhat", artifacts: __dirname + "/../node_modules/.cache/hardhat-artifacts" },
  networks: {
    hardhat: {
      chainId: 8453,
      hardfork: "cancun",
      ...(fork ? { forking: { url: fork, ...(process.env.FORK_BLOCK ? { blockNumber: Number(process.env.FORK_BLOCK) } : {}) } } : {}),
    },
  },
}
