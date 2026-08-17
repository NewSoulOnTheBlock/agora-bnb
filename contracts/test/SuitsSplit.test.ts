import { expect } from "chai";
import { ethers } from "hardhat";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const WAD = 10n ** 18n;
const SUPPLY = 1_000_000_000n * WAD;
const RICH = 10_000_000n * WAD;

describe("StakedSuits + Distributor (10% NFT slice)", () => {
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;

  let agora: any, suits: any, staking: any, suitsVault: any, distributor: any;

  beforeEach(async () => {
    [owner, alice, bob, carol] = await ethers.getSigners();
    for (const s of [owner, alice, bob, carol]) await setBalance(s.address, RICH);

    agora = await (await ethers.getContractFactory("MockAgora")).deploy(SUPPLY);
    suits = await (await ethers.getContractFactory("MockSuits")).deploy();

    staking = await (
      await ethers.getContractFactory("StakedAgora")
    ).deploy(await agora.getAddress(), owner.address);

    suitsVault = await (
      await ethers.getContractFactory("StakedSuits")
    ).deploy(await suits.getAddress(), owner.address);

    distributor = await (
      await ethers.getContractFactory("Distributor")
    ).deploy(await staking.getAddress(), await suitsVault.getAddress(), owner.address);

    // Alice: AGORA staker. Bob: Suits holder. Carol: Suits holder.
    await agora.transfer(alice.address, 1000n * WAD);
    await suits.mintMany(bob.address, 1, 3); // ids 1,2,3
    await suits.mintMany(carol.address, 4, 1); // id 4
  });

  const stakeAgora = async (who: HardhatEthersSigner, amt: bigint) => {
    await agora.connect(who).approve(await staking.getAddress(), amt);
    await staking.connect(who).deposit(amt, who.address);
  };
  const stakeSuits = async (who: HardhatEthersSigner, ids: number[]) => {
    await suits.connect(who).setApprovalForAll(await suitsVault.getAddress(), true);
    await suitsVault.connect(who).stake(ids);
  };

  // =========================================================================
  describe("StakedSuits", () => {
    it("takes custody and records the staker", async () => {
      await stakeSuits(bob, [1, 2]);

      expect(await suits.ownerOf(1)).to.equal(await suitsVault.getAddress());
      expect(await suitsVault.stakerOf(1)).to.equal(bob.address);
      expect(await suitsVault.stakedCount(bob.address)).to.equal(2n);
      expect(await suitsVault.totalStaked()).to.equal(2n);
    });

    it("returns NFTs only to the original staker", async () => {
      await stakeSuits(bob, [1, 2]);

      await expect(suitsVault.connect(carol).unstake([1])).to.be.revertedWithCustomError(
        suitsVault,
        "NotStaker"
      );

      await suitsVault.connect(bob).unstake([1, 2]);
      expect(await suits.ownerOf(1)).to.equal(bob.address);
      expect(await suitsVault.totalStaked()).to.equal(0n);
    });

    it("pays every staked Suit equally", async () => {
      await stakeSuits(bob, [1, 2, 3]); // 3 of 4
      await stakeSuits(carol, [4]); // 1 of 4

      await suitsVault.notifyReward({ value: ethers.parseEther("4") });

      expect(await suitsVault.pendingYield(bob.address)).to.equal(ethers.parseEther("3"));
      expect(await suitsVault.pendingYield(carol.address)).to.equal(ethers.parseEther("1"));
    });

    it("pays nothing for a Suit staked after the reward", async () => {
      await stakeSuits(bob, [1]);
      await suitsVault.notifyReward({ value: ethers.parseEther("10") });
      await stakeSuits(carol, [4]);

      expect(await suitsVault.pendingYield(bob.address)).to.equal(ethers.parseEther("10"));
      expect(await suitsVault.pendingYield(carol.address)).to.equal(0n);
    });

    it("keeps accrued rewards after unstaking", async () => {
      await stakeSuits(bob, [1]);
      await suitsVault.notifyReward({ value: ethers.parseEther("5") });
      await suitsVault.connect(bob).unstake([1]);

      // The NFT went home; the yield it already earned did not evaporate.
      expect(await suitsVault.pendingYield(bob.address)).to.equal(ethers.parseEther("5"));
      await expect(suitsVault.connect(bob).claim()).to.not.be.reverted;
    });

    it("stops accruing once unstaked", async () => {
      await stakeSuits(bob, [1]);
      await stakeSuits(carol, [4]);
      await suitsVault.connect(bob).unstake([1]);

      await suitsVault.notifyReward({ value: ethers.parseEther("10") });

      expect(await suitsVault.pendingYield(bob.address)).to.equal(0n);
      expect(await suitsVault.pendingYield(carol.address)).to.equal(ethers.parseEther("10"));
    });

    it("pays out on claim", async () => {
      await stakeSuits(bob, [1]);
      await suitsVault.notifyReward({ value: ethers.parseEther("3") });

      const before = await ethers.provider.getBalance(bob.address);
      const rc = await (await suitsVault.connect(bob).claim()).wait();
      const gas = BigInt(rc!.gasUsed) * BigInt(rc!.gasPrice);

      expect(await ethers.provider.getBalance(bob.address)).to.equal(
        before + ethers.parseEther("3") - gas
      );
      expect(await ethers.provider.getBalance(await suitsVault.getAddress())).to.equal(0n);
    });

    it("reverts rather than swallowing ETH when nothing is staked", async () => {
      await expect(
        suitsVault.notifyReward({ value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(suitsVault, "NoStakers");
    });

    it("does not credit a raw safeTransferFrom deposit", async () => {
      await suits
        .connect(bob)
        ["safeTransferFrom(address,address,uint256)"](
          bob.address,
          await suitsVault.getAddress(),
          1
        );
      // Accepted, but NOT counted — otherwise a raw transfer would bypass stake().
      expect(await suitsVault.totalStaked()).to.equal(0n);
      expect(await suitsVault.stakerOf(1)).to.equal(ethers.ZeroAddress);
    });
  });

  // =========================================================================
  describe("Distributor — the 10/90 split", () => {
    beforeEach(async () => {
      await stakeAgora(alice, 1000n * WAD);
      await stakeSuits(bob, [1]);
    });

    it("defaults to 10% Suits / 90% AGORA", async () => {
      expect(await distributor.suitsBps()).to.equal(1000);

      await distributor.distribute({ value: ethers.parseEther("100") });

      expect(await suitsVault.pendingYield(bob.address)).to.equal(ethers.parseEther("10"));
      expect(await staking.pendingYield(alice.address)).to.equal(ethers.parseEther("90"));
      expect(await distributor.cumulativeToSuits()).to.equal(ethers.parseEther("10"));
      expect(await distributor.cumulativeToAgora()).to.equal(ethers.parseEther("90"));
    });

    it("leaves nothing behind", async () => {
      await distributor.distribute({ value: ethers.parseEther("100") });
      expect(await ethers.provider.getBalance(await distributor.getAddress())).to.equal(0n);
    });

    it("splits a 10% slice across multiple staked Suits", async () => {
      await stakeSuits(carol, [4]); // now 2 staked

      await distributor.distribute({ value: ethers.parseEther("100") });

      // 10 ETH over 2 NFTs
      expect(await suitsVault.pendingYield(bob.address)).to.equal(ethers.parseEther("5"));
      expect(await suitsVault.pendingYield(carol.address)).to.equal(ethers.parseEther("5"));
    });

    it("previews the split without moving anything", async () => {
      const [toSuits, toAgora] = await distributor.preview(ethers.parseEther("100"));
      expect(toSuits).to.equal(ethers.parseEther("10"));
      expect(toAgora).to.equal(ethers.parseEther("90"));
      expect(await distributor.cumulativeToSuits()).to.equal(0n);
    });

    it("caps the NFT slice so governance cannot redirect the whole stream", async () => {
      await expect(distributor.setSuitsBps(3001)).to.be.revertedWithCustomError(
        distributor,
        "SuitsBpsTooHigh"
      );
      await expect(distributor.setSuitsBps(3000)).to.not.be.reverted;
    });

    it("blocks non-owners from changing the split", async () => {
      await expect(
        distributor.connect(alice).setSuitsBps(2000)
      ).to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount");
    });

    it("has no withdrawal path", () => {
      for (const fn of ["withdraw", "rescue", "execute", "sweepTo", "transferOwnership2"]) {
        expect(distributor.interface.hasFunction(fn), `unexpected ${fn}()`).to.equal(false);
      }
    });
  });

  // =========================================================================
  describe("Distributor — empty-sink rerouting", () => {
    it("sends everything to AGORA when no Suits are staked", async () => {
      await stakeAgora(alice, 1000n * WAD);

      await expect(distributor.distribute({ value: ethers.parseEther("100") })).to.emit(
        distributor,
        "ReroutedToAgora"
      );

      expect(await staking.pendingYield(alice.address)).to.equal(ethers.parseEther("100"));
      expect(await distributor.cumulativeToSuits()).to.equal(0n);
    });

    it("sends everything to Suits when no AGORA is staked", async () => {
      await stakeSuits(bob, [1]);

      await expect(distributor.distribute({ value: ethers.parseEther("100") })).to.emit(
        distributor,
        "ReroutedToSuits"
      );

      expect(await suitsVault.pendingYield(bob.address)).to.equal(ethers.parseEther("100"));
    });

    it("reverts when neither side has stakers, rather than stranding ETH", async () => {
      await expect(
        distributor.distribute({ value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(distributor, "NoStakersAnywhere");

      // The caller keeps its ETH; nothing is parked in a contract with no exit.
      expect(await ethers.provider.getBalance(await distributor.getAddress())).to.equal(0n);
    });

    it("flushes an idle balance through the same split rule", async () => {
      await stakeAgora(alice, 1000n * WAD);
      await stakeSuits(bob, [1]);

      await owner.sendTransaction({
        to: await distributor.getAddress(),
        value: ethers.parseEther("100"),
      });
      expect(await ethers.provider.getBalance(await distributor.getAddress())).to.equal(
        ethers.parseEther("100")
      );

      await distributor.connect(carol).flush();

      expect(await suitsVault.pendingYield(bob.address)).to.equal(ethers.parseEther("10"));
      expect(await staking.pendingYield(alice.address)).to.equal(ethers.parseEther("90"));
      expect(await ethers.provider.getBalance(await distributor.getAddress())).to.equal(0n);
    });
  });

  // =========================================================================
  describe("conservation", () => {
    it("never distributes more or less than it received", async () => {
      await stakeAgora(alice, 1000n * WAD);
      await stakeSuits(bob, [1, 2, 3]);
      await stakeSuits(carol, [4]);

      const amounts = ["1", "0.333333333333333333", "7", "0.000000000000000001"];
      let total = 0n;
      for (const a of amounts) {
        const v = ethers.parseEther(a);
        total += v;
        await distributor.distribute({ value: v });
      }

      const toSuits = await distributor.cumulativeToSuits();
      const toAgora = await distributor.cumulativeToAgora();
      expect(toSuits + toAgora).to.equal(total);

      // And every wei is claimable — no dust trapped in either vault.
      const suitsHeld = await ethers.provider.getBalance(await suitsVault.getAddress());
      const agoraHeld = await ethers.provider.getBalance(await staking.getAddress());
      expect(suitsHeld).to.equal(toSuits);
      expect(agoraHeld).to.equal(toAgora);
    });
  });
});
