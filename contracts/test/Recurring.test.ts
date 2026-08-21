import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { deployIntentOS } from "./fixtures";

describe("RecurringRegistry", () => {
  it("creates a job, becomes due, and records a run", async () => {
    const env = await loadFixture(deployIntentOS);
    const recurring = await (await ethers.getContractFactory("RecurringRegistry")).deploy(env.signers.deployer.address);
    await recurring.setCoordinator(env.signers.coordinator.address);
    await recurring.connect(env.signers.coordinator).createFor(
      env.signers.user.address,
      60,
      3,
      "Pay 100 USDG gaslessly to 0x000000000000000000000000000000000000cafe every month",
    );
    expect(await recurring.jobCount()).to.equal(1);
    expect((await recurring.dueIds(10)).length).to.equal(0);

    await time.increase(61);
    const due = await recurring.dueIds(10);
    expect(due.length).to.equal(1);
    await recurring.connect(env.signers.coordinator).markRun(due[0]);
    const job = await recurring.jobAt(0);
    expect(job.runs).to.equal(1);
    expect(job.active).to.equal(true);
  });
});
