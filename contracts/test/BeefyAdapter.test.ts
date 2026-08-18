import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Guard tests for `BeefyCLMAdapter`, against deliberately simple mocks.
 *
 * These prove the parts that must hold no matter what the venue does: who may
 * move value, that a manipulated or unreadable price cannot be traded or
 * valued against, that the capacity cap binds, and that `totalAssets()` cannot
 * revert — because `Treasury.payout()` touches `nav()`, so an adapter that can
 * revert a NAV read can brick redemption for everyone.
 *
 * The economics — does a real deposit mint the right shares, what does a round
 * trip actually cost — are proven separately in `scripts/rehearse-beefy.ts`
 * against the live Beefy vault on a fork. A mock that agreed with my own
 * assumptions would prove nothing there.
 */
describe("BeefyCLMAdapter", () => {
  const Q96 = 2n ** 96n; // sqrtPriceX96 for a 1:1 price, so the maths stays readable
  const ONE = ethers.parseEther("1");

  async function deploy() {
    const [owner, whale, stranger] = await ethers.getSigners();

    const weth = await (await ethers.getContractFactory("MockWETH")).deploy();
    const paired = await (await ethers.getContractFactory("MockToken")).deploy("Paired", "PAIR");
    const pool = await (
      await ethers.getContractFactory("MockV3Pool")
    ).deploy(await weth.getAddress(), await paired.getAddress(), Q96, 0);
    const strategy = await (await ethers.getContractFactory("MockStrategy")).deploy(await pool.getAddress());
    const clm = await (
      await ethers.getContractFactory("MockCLM")
    ).deploy(await weth.getAddress(), await paired.getAddress(), await strategy.getAddress());
    const rp = await (await ethers.getContractFactory("MockRewardPool")).deploy(await clm.getAddress());
    const treasury = await (await ethers.getContractFactory("TreasuryCaller")).deploy();

    const adapter = await (
      await ethers.getContractFactory("BeefyCLMAdapter")
    ).deploy(
      await treasury.getAddress(),
      await clm.getAddress(),
      await rp.getAddress(),
      await weth.getAddress(),
      owner.address
    );

    // Back every WETH the pool mints with real ether, so unwrapping works.
    await weth.fund({ value: ethers.parseEther("500") });

    // Seed the vault with an unrelated depositor, so the adapter is not
    // instantly 100% of it and the share cap is not tripped by construction.
    await weth.connect(whale).deposit({ value: ethers.parseEther("50") });
    await paired.mint(whale.address, ethers.parseEther("50"));
    await weth.connect(whale).approve(await clm.getAddress(), ethers.MaxUint256);
    await paired.connect(whale).approve(await clm.getAddress(), ethers.MaxUint256);
    await clm.connect(whale).deposit(ethers.parseEther("50"), ethers.parseEther("50"), 0);

    await owner.sendTransaction({ to: await treasury.getAddress(), value: ethers.parseEther("20") });

    return { owner, whale, stranger, weth, paired, pool, clm, rp, treasury, adapter };
  }

  describe("construction", () => {
    it("derives the pool and the paired token from the vault itself", async () => {
      const { adapter, pool, paired } = await loadFixture(deploy);
      expect(await adapter.pool()).to.equal(await pool.getAddress());
      expect(await adapter.paired()).to.equal(await paired.getAddress());
      expect(await adapter.wethIsToken0()).to.equal(true);
    });

    it("refuses a vault whose pair contains no WETH", async () => {
      const [owner] = await ethers.getSigners();
      const { weth, treasury } = await loadFixture(deploy);

      const a = await (await ethers.getContractFactory("MockToken")).deploy("A", "A");
      const b = await (await ethers.getContractFactory("MockToken")).deploy("B", "B");
      const pool = await (
        await ethers.getContractFactory("MockV3Pool")
      ).deploy(await a.getAddress(), await b.getAddress(), Q96, 0);
      const strat = await (await ethers.getContractFactory("MockStrategy")).deploy(await pool.getAddress());
      const clm = await (
        await ethers.getContractFactory("MockCLM")
      ).deploy(await a.getAddress(), await b.getAddress(), await strat.getAddress());

      const F = await ethers.getContractFactory("BeefyCLMAdapter");
      await expect(
        F.deploy(
          await treasury.getAddress(),
          await clm.getAddress(),
          ethers.ZeroAddress,
          await weth.getAddress(),
          owner.address
        )
      ).to.be.revertedWithCustomError(F, "PairMismatch");
    });

    it("refuses a reward pool that stakes some other token", async () => {
      const [owner] = await ethers.getSigners();
      const { weth, clm, treasury, paired } = await loadFixture(deploy);

      const wrongRp = await (await ethers.getContractFactory("MockRewardPool")).deploy(await paired.getAddress());
      const F = await ethers.getContractFactory("BeefyCLMAdapter");
      await expect(
        F.deploy(
          await treasury.getAddress(),
          await clm.getAddress(),
          await wrongRp.getAddress(),
          await weth.getAddress(),
          owner.address
        )
      ).to.be.revertedWithCustomError(F, "PairMismatch");
    });
  });

  describe("access control", () => {
    it("only the Treasury may deposit, withdraw or realize", async () => {
      const { adapter, stranger } = await loadFixture(deploy);

      await expect(adapter.connect(stranger).deposit({ value: ONE })).to.be.revertedWithCustomError(
        adapter,
        "NotTreasury"
      );
      await expect(adapter.connect(stranger).withdraw(ONE)).to.be.revertedWithCustomError(
        adapter,
        "NotTreasury"
      );
      await expect(adapter.connect(stranger).realizeSurplus()).to.be.revertedWithCustomError(
        adapter,
        "NotTreasury"
      );
    });

    it("rejects a swap callback from anyone but the pool", async () => {
      const { adapter, stranger } = await loadFixture(deploy);
      await expect(
        adapter.connect(stranger).uniswapV3SwapCallback(1, 0, "0x")
      ).to.be.revertedWithCustomError(adapter, "NotPool");
    });

    it("has no function that sends value to a caller-chosen address", async () => {
      const { adapter } = await loadFixture(deploy);
      const frags = adapter.interface.fragments.filter((f: any) => f.type === "function") as any[];
      for (const f of frags) {
        const takesAddress = f.inputs.some((i: any) => i.type === "address");
        // `sweepRewardToken(address)` names a token, never a destination — its
        // destination is the immutable treasury. `transferOwnership` moves the
        // parameter-tuning role and can send nothing.
        const benign = ["sweepRewardToken", "transferOwnership", "uniswapV3SwapCallback"];
        if (takesAddress && f.stateMutability !== "view") {
          expect(benign, `${f.name} takes an address`).to.include(f.name);
        }
      }
    });
  });

  describe("deposit", () => {
    it("splits in ratio, mints shares, and stakes them in the reward pool", async () => {
      const { adapter, treasury, rp, clm } = await loadFixture(deploy);

      await treasury.callDeposit(await adapter.getAddress(), ONE, { value: ONE });

      expect(await adapter.principal()).to.equal(ONE);
      expect(await adapter.sharesHeld()).to.be.gt(0);
      // Everything staked; nothing left loose in the adapter.
      expect(await rp.balanceOf(await adapter.getAddress())).to.equal(await adapter.sharesHeld());
      expect(await clm.balanceOf(await adapter.getAddress())).to.equal(0);
    });

    it("values the position at what went in, when the price has not moved", async () => {
      const { adapter, treasury } = await loadFixture(deploy);
      await treasury.callDeposit(await adapter.getAddress(), ONE, { value: ONE });
      expect(await adapter.totalAssets()).to.be.closeTo(ONE, ethers.parseEther("0.001"));
    });

    it("refuses to deposit while Beefy reports the vault is not calm", async () => {
      const { adapter, treasury, clm } = await loadFixture(deploy);
      await clm.setCalm(false);
      await expect(
        treasury.callDeposit(await adapter.getAddress(), ONE, { value: ONE })
      ).to.be.revertedWithCustomError(adapter, "NotCalm");
    });

    it("refuses to trade when spot has left the TWAP band", async () => {
      const { adapter, treasury, pool } = await loadFixture(deploy);
      // Spot unchanged, TWAP far away — the shape of a fresh manipulation.
      await pool.setTwapTick(5000);
      await expect(
        treasury.callDeposit(await adapter.getAddress(), ONE, { value: ONE })
      ).to.be.revertedWithCustomError(adapter, "PriceOutOfBand");
    });

    it("enforces the vault-share capacity cap", async () => {
      const { adapter, treasury, owner } = await loadFixture(deploy);
      // The seeded vault holds 100e18 of shares; 1% of it is the ceiling here.
      await adapter.connect(owner).setParams(1800, 200, 100, 100);
      await expect(
        treasury.callDeposit(await adapter.getAddress(), ethers.parseEther("5"), {
          value: ethers.parseEther("5"),
        })
      ).to.be.revertedWithCustomError(adapter, "VaultShareCapExceeded");
    });
  });

  describe("totalAssets never reverts", () => {
    it("returns 0 and reports unhealthy when the oracle is unreadable", async () => {
      const { adapter, treasury, pool } = await loadFixture(deploy);
      await treasury.callDeposit(await adapter.getAddress(), ONE, { value: ONE });
      expect(await adapter.totalAssets()).to.be.gt(0);

      await pool.setObserveBroken(true);

      // The point of the whole wrapper: a broken oracle must not be able to
      // make a NAV read revert, because that would brick redemption.
      expect(await adapter.totalAssets()).to.equal(0);
      expect(await adapter.healthy()).to.equal(false);
    });
  });

  describe("valuation is manipulation-resistant", () => {
    // WETH is token0 here, so the paired leg is valued as `amount1 / price`.
    // A *falling* spot price is therefore the direction that would INFLATE the
    // position — that is the move an attacker wants, and the one `min` must
    // discard.
    it("ignores a spot move that would inflate the position", async () => {
      const { adapter, treasury, pool } = await loadFixture(deploy);
      await treasury.callDeposit(await adapter.getAddress(), ONE, { value: ONE });
      const before = await adapter.totalAssets();

      await pool.setSpot(Q96 / 2n, -13863); // spot ×¼ in price terms; TWAP unmoved

      // Valued against the untouched TWAP, so the pump buys the attacker nothing.
      expect(await adapter.totalAssets()).to.equal(before);
    });

    it("does reflect a spot move that deflates the position", async () => {
      const { adapter, treasury, pool } = await loadFixture(deploy);
      await treasury.callDeposit(await adapter.getAddress(), ONE, { value: ONE });
      const before = await adapter.totalAssets();

      await pool.setSpot(Q96 * 2n, 13863);

      // Understating is the safe direction, so this one is allowed through.
      expect(await adapter.totalAssets()).to.be.lt(before);
    });
  });

  describe("realizeSurplus", () => {
    it("returns 0 rather than reverting when there is nothing to realize", async () => {
      const { adapter, treasury } = await loadFixture(deploy);
      await treasury.callDeposit(await adapter.getAddress(), ONE, { value: ONE });
      expect(await treasury.callRealize.staticCall(await adapter.getAddress())).to.equal(0);
    });

    it("sends appreciation above the high-water mark to the Treasury", async () => {
      const { adapter, treasury, clm } = await loadFixture(deploy);
      const addr = await adapter.getAddress();
      await treasury.callDeposit(addr, ONE, { value: ONE });

      const principalBefore = await adapter.principal();
      await clm.addYield(ethers.parseEther("10"), ethers.parseEther("10"));
      expect(await adapter.totalAssets()).to.be.gt(principalBefore);

      const before = await ethers.provider.getBalance(await treasury.getAddress());
      await treasury.callRealize(addr);
      const after = await ethers.provider.getBalance(await treasury.getAddress());

      expect(after).to.be.gt(before);
      // The mark is a high-water mark: realizing income must not move it.
      expect(await adapter.principal()).to.equal(principalBefore);
    });

    it("refuses to realize into an uncalm vault", async () => {
      const { adapter, treasury, clm } = await loadFixture(deploy);
      const addr = await adapter.getAddress();
      await treasury.callDeposit(addr, ONE, { value: ONE });
      await clm.addYield(ethers.parseEther("10"), ethers.parseEther("10"));
      await clm.setCalm(false);

      await expect(treasury.callRealize(addr)).to.be.revertedWithCustomError(adapter, "NotCalm");
    });

    it("enforces the cooldown between realizations", async () => {
      const { adapter, treasury, clm } = await loadFixture(deploy);
      const addr = await adapter.getAddress();
      await treasury.callDeposit(addr, ONE, { value: ONE });

      await clm.addYield(ethers.parseEther("10"), ethers.parseEther("10"));
      await treasury.callRealize(addr);

      await clm.addYield(ethers.parseEther("10"), ethers.parseEther("10"));
      await expect(treasury.callRealize(addr)).to.be.revertedWithCustomError(adapter, "CooldownActive");

      await time.increase(3601);
      await expect(treasury.callRealize(addr)).to.not.be.reverted;
    });
  });

  describe("withdraw", () => {
    it("returns the requested amount and reduces principal", async () => {
      const { adapter, treasury } = await loadFixture(deploy);
      const addr = await adapter.getAddress();
      await treasury.callDeposit(addr, ONE, { value: ONE });

      const half = ONE / 2n;
      const before = await ethers.provider.getBalance(await treasury.getAddress());
      await treasury.callWithdraw(addr, half);
      const after = await ethers.provider.getBalance(await treasury.getAddress());

      expect(after - before).to.be.closeTo(half, ethers.parseEther("0.01"));
      expect(await adapter.principal()).to.be.lt(ONE);
    });

    it("fully exits and clears the high-water mark", async () => {
      const { adapter, treasury } = await loadFixture(deploy);
      const addr = await adapter.getAddress();
      await treasury.callDeposit(addr, ONE, { value: ONE });

      await treasury.callWithdraw(addr, ethers.MaxUint256);

      expect(await adapter.sharesHeld()).to.equal(0);
      expect(await adapter.totalAssets()).to.equal(0);
      expect(await adapter.principal()).to.equal(0);
    });
  });

  describe("governance is bounded", () => {
    it("rejects out-of-range parameters", async () => {
      const { adapter, owner } = await loadFixture(deploy);
      await expect(adapter.connect(owner).setParams(30, 200, 100, 2000)).to.be.revertedWithCustomError(
        adapter,
        "BadParam"
      );
      await expect(adapter.connect(owner).setParams(1800, 0, 100, 2000)).to.be.revertedWithCustomError(
        adapter,
        "BadParam"
      );
      await expect(adapter.connect(owner).setParams(1800, 200, 2000, 2000)).to.be.revertedWithCustomError(
        adapter,
        "BadParam"
      );
      await expect(adapter.connect(owner).setParams(1800, 200, 100, 9000)).to.be.revertedWithCustomError(
        adapter,
        "BadParam"
      );
    });

    it("blocks non-owners from tuning risk parameters", async () => {
      const { adapter, stranger } = await loadFixture(deploy);
      await expect(adapter.connect(stranger).setParams(1800, 200, 100, 2000)).to.be.reverted;
    });

    it("refuses to sweep the pair tokens as if they were rewards", async () => {
      const { adapter, weth, paired } = await loadFixture(deploy);
      await expect(adapter.sweepRewardToken(await weth.getAddress())).to.be.revertedWithCustomError(
        adapter,
        "CannotSweepPairToken"
      );
      await expect(adapter.sweepRewardToken(await paired.getAddress())).to.be.revertedWithCustomError(
        adapter,
        "CannotSweepPairToken"
      );
    });
  });
});
