// We require the Hardhat Runtime Environment explicitly here. This is optional
// but useful for running the script in a standalone fashion through `node <script>`.
//
// You can also run a script with `npx hardhat run <script>`. If you do that, Hardhat
// will compile your contracts, add the Hardhat Runtime Environment's members to the
// global scope, and execute the script.
const hre = require("hardhat");
const ethers = hre.ethers;

const EIP712_SAFE_TX_TYPE = {
    // "SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)"
    SafeTx: [
        { type: "address", name: "to" },
        { type: "uint256", name: "value" },
        { type: "bytes", name: "data" },
        { type: "uint8", name: "operation" },
        { type: "uint256", name: "safeTxGas" },
        { type: "uint256", name: "baseGas" },
        { type: "uint256", name: "gasPrice" },
        { type: "address", name: "gasToken" },
        { type: "address", name: "refundReceiver" },
        { type: "uint256", name: "nonce" },
    ]
}

const EIP712_SAFE_MESSAGE_TYPE = {
    // "SafeMessage(bytes message)"
    SafeMessage: [
        { type: "bytes", name: "message" },
    ]
}

function calculateSafeTransactionHash(safe, safeTx, chainId) {
  return ethers.utils._TypedDataEncoder.hash({ verifyingContract: safe.address, chainId }, EIP712_SAFE_TX_TYPE, safeTx)
}

async function safeSignTypedData(signer, safe, safeTx) {
    const cid = (await ethers.provider.getNetwork()).chainId
    const signerAddress = await signer.getAddress()
    return {
        signer: signerAddress,
        data: await signer._signTypedData({ verifyingContract: safe.address, chainId: cid }, EIP712_SAFE_TX_TYPE, safeTx)
    }
}

async function signHash(signer, hash) {
  const typedDataHash = ethers.utils.arrayify(hash)
  const signerAddress = await signer.getAddress()
  return {
      signer: signerAddress,
      data: (await signer.signMessage(typedDataHash)).replace(/1b$/, "1f").replace(/1c$/, "20")
  }
}

async function safeSignMessage(signer, safe, safeTx) {
  const cid = (await ethers.provider.getNetwork()).chainId
  return signHash(signer, calculateSafeTransactionHash(safe, safeTx, cid))
}

async function buildSignatureBytes(confirmingAccounts, txHash) {
  let signatureBytes = "0x"
  confirmingAccounts.sort();
  for (var i=0; i<confirmingAccounts.length; i++) {
      // Adjust v (it is + 27 => EIP-155 and + 4 to differentiate them from typed data signatures in the Safe)
      let signature = (await confirmingAccounts[i].signTransaction(txHash)).replace('0x', '').replace(/00$/,"1f").replace(/01$/,"20")
      signatureBytes += (signature)
  }
  return signatureBytes
}

async function executeTxWithSigners(safe, tx, signers) {
    const sigs = await Promise.all(signers.map((signer) => safeSignTypedData(signer, safe, tx)))
    return executeTx(safe, tx, sigs)
}

async function executeContractCallWithSigners(safe, contract, method, params, signers) {
    const tx = buildContractCall(contract, method, params, await safe.nonce())
    return executeTxWithSigners(safe, tx, signers)
}

function buildContractCall(contract, method, params, nonce) {
    const data = contract.interface.encodeFunctionData(method, params)
    return buildSafeTransaction(
        contract.address,
        data,
        0,
        nonce
    )
}

async function safeApproveHash(signer, safe, safeTx, skipOnChainApproval) {
  if (!skipOnChainApproval) {
      if (!signer.provider) throw Error("Provider required for on-chain approval")
      const chainId = (await signer.provider.getNetwork()).chainId
      const typedDataHash = ethers.utils.arrayify(calculateSafeTransactionHash(safe, safeTx, chainId))
      const signerSafe = safe.connect(signer)
      await signerSafe.approveHash(typedDataHash)
  }
  const signerAddress = await signer.getAddress()
  return {
      signer: signerAddress,
      data: "0x000000000000000000000000" + signerAddress.slice(2) + "0000000000000000000000000000000000000000000000000000000000000000" + "01"
  }
}

async function executeTx(safe, safeTx, signatures) {
  const signatureBytes = buildSignatureBytes(signatures)
  return safe.execTransaction(safeTx.to, safeTx.value, safeTx.data, safeTx.operation, safeTx.safeTxGas, safeTx.baseGas, safeTx.gasPrice, safeTx.gasToken, safeTx.refundReceiver, signatureBytes)
}

function buildSafeTransaction(
    to, data, operation, nonce
) {
    return {
        to,
        value: 0,
        data: data || "0x",
        operation: operation || 0,
        safeTxGas: 0,
        baseGas: 0,
        gasPrice: 0,
        gasToken: ethers.constants.AddressZero,
        refundReceiver: ethers.constants.AddressZero,
        nonce: nonce 
    }
}

async function main() {
  const signers = await ethers.getSigners();

  const Token = await ethers.getContractFactory("MyToken");
  const token = await Token.deploy();
  await token.deployed();

  const GnosisSafe = await ethers.getContractFactory("GnosisSafe");
  const safe = await GnosisSafe.deploy();
  await safe.deployed();
  console.log("Safe deployed", safe.address);

  await token.mint(safe.address, ethers.utils.parseEther("100"));

  await safe.setup(
    [signers[0].address, signers[1].address, signers[2].address, signers[3].address],
    2,
    ethers.constants.AddressZero,
    "0x",
    ethers.constants.AddressZero,
    ethers.constants.AddressZero,
    0,
    ethers.constants.AddressZero
  );
  console.log("Safe setup done");

  const erc20Int = new ethers.utils.Interface([  
    "function balanceOf(address account) external view returns (uint256)",
    "function transfer(address recipient, uint256 amount) external returns (bool)",
    "function transferFrom(address sender, address recipient, uint256 amount) external returns (bool)"
  ]);
  const encodedFunctionData = token.interface.encodeFunctionData("transfer", [
    signers[0].address,
    ethers.utils.parseEther("100")
  ]);

  const safeTx = buildContractCall(token, "transfer", [signers[0].address, ethers.utils.parseEther("100")], await safe.nonce());
  const wallet0 = new ethers.Wallet("", ethers.provider);
  const wallet1 = new ethers.Wallet("", ethers.provider);
  // const sign0 = await safeSignMessage(wallet0, safe, safeTx);
  // const sign1 = await safeSignMessage(wallet1, safe, safeTx);
  const txHash = safe.getTransactionHash(
    token.address,
    0,
    encodedFunctionData,
    0,
    0,
    0,
    0,
    ethers.constants.AddressZero,
    ethers.constants.AddressZero,
    await safe.nonce()
  );
  const sign = await buildSignatureBytes([wallet0, wallet1], txHash);
  console.log(sign)
  console.log()

  // const encodedTxData = await safe.encodeTransactionData(
  //   token.address,
  //   0,
  //   encodedFunctionData,
  //   0,
  //   0,
  //   0,
  //   0,
  //   ethers.constants.AddressZero,
  //   ethers.constants.AddressZero,
  //   await safe.nonce()
  // );
  // console.log(encodedTxData);

  await safe.execTransaction(
    token.address, 
    0, 
    encodedFunctionData, 
    0, 
    0, 
    0, 
    0,
    ethers.constants.AddressZero, 
    ethers.constants.AddressZero, 
    sign
  );

  // await executeContractCallWithSigners(safe, token, "transfer", [signers[0].address, ethers.utils.parseEther("100")], [wallet0, wallet1]);

  console.log(ethers.utils.formatEther(await token.balanceOf(signers[0].address)))
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
