import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { deployIntentOS, shares } from "./fixtures";

describe("RwaVault", () => {
  it("deposits and withdraws an attested xStock 1:1", async () => {
    const env = await loadFixture(deployIntentOS);
    const tsla = env.stocks.TSLAx;
    const vault = await (await ethers.getContractFactory("RwaVault")).deploy(
      env.signers.deployer.address,
      await tsla.getAddress(),
      await env.rwaRegistry.getAddress(),
      "IntentOS TSLAx Vault",
      "vTSLAx",
    );
    await tsla.connect(env.signers.user).approve(await vault.getAddress(), shares(10));
    await vault.connect(env.signers.user).deposit(shares(10));
    expect(await vault.balanceOf(env.signers.user.address)).to.equal(shares(10));
    await vault.connect(env.signers.user).withdraw(shares(4));
    expect(await vault.balanceOf(env.signers.user.address)).to.equal(shares(6));
    expect(await tsla.balanceOf(await vault.getAddress())).to.equal(shares(6));
  });
});
