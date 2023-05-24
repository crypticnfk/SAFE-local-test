require("@nomicfoundation/hardhat-toolbox");
const dotenv = require("dotenv");

dotenv.config();

const accounts = {
  mnemonic:
    process.env.MNEMONIC ||
    "test test test test test test test test test test test test",
};

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.5.6",
  localhost: {
    accounts,
    url: `http://localhost:8545`,
  },
};
