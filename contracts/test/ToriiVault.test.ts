import { expect } from "chai";
import { ethers } from "hardhat";
import { setBalance, impersonateAccount } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * ToriiVault — the Flap tax vault for BNB Chain.
 *
 * RUN WITH:  BNB_TEST=1 npx hardhat test test/ToriiVault.test.ts
 *
 * The env flag makes the in-process node report chain 56. Flap's `VaultBase`
 * resolves the Guardian from a hardcoded chainid table and reverts
 * `UnsupportedChain` on Hardhat's default 31337, so without it every
 * Guardian-gated case fails for a reason that has nothing to do with the vault.
 */

const WAD = 10n ** 18n;
const RICH = 10_000n * WAD;

// From flap/VaultBase.sol — the chain-56 Guardian. Hardcoded upstream, so there
// is no getter to read it from and no setter that could move it.
const GUARDIAN_56 = "0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

/** Chains for which Flap's `VaultBase` can resolve a Portal and a Guardian. */
const FLAP_CHAINS = [56n, 97n, 4663n, 46630n];

/**
 * Skip rather than fail on an unsupported chain.
 *
 * A plain `npx hardhat test` runs at 31337, where every Flap lookup reverts
 * `UnsupportedChain`. Letting these fail there would break the whole suite for
 * an environment reason rather than a defect, and would train people to ignore
 * red output. Skipping keeps the default run green and says why.
 */
async function skipUnlessFlapChain(ctx: Mocha.Context) {
  const { chainId } = await ethers.provider.getNetwork();
  if (!FLAP_CHAINS.includes(chainId)) {
    console.log(
      `      ↳ skipped on chain ${chainId}: Flap resolves its Portal and Guardian ` +
        `from a hardcoded chainid table. Run with BNB_TEST=1 to test as chain 56.`
    );
    ctx.skip();
  }
}

describe("ToriiVault (Flap V3 tax vault)", () => {
  before(async function () {
    await skipUnlessFlapChain(this);
  });

  let deployer: HardhatEthersSigner;
  let anyone: HardhatEthersSigner;
  let rescue: HardhatEthersSigner;

  let vault: any, treasury: any, router: any, token: any;

  beforeEach(async () => {
    [deployer, anyone, rescue] = await ethers.getSigners();
    for (const s of [deployer, anyone, rescue]) await setBalance(s.address, RICH);

    treasury = await (await ethers.getContractFactory("MockFundSink")).deploy();
    token = await (await ethers.getContractFactory("MockTaxToken")).deploy(0);
    // 1 token -> 0.001 BNB
    router = await (await ethers.getContractFactory("MockPancakeRouter")).deploy(WBNB, WAD / 1000n);
    await setBalance(await router.getAddress(), RICH);

    vault = await (await ethers.getContractFactory("ToriiVault")).deploy(
      await treasury.getAddress(),
      await token.getAddress(),
      ethers.ZeroAddress,
      await router.getAddress()
    );
  });

  const send = (amount: bigint) =>
    anyone.sendTransaction({ to: vault.getAddress(), value: amount });

  describe("revenue recognition", () => {
    it("recognises native revenue by delta on receive()", async () => {
      await expect(send(WAD)).to.emit(vault, "RevenueRecognized").withArgs(WAD, WAD);
      expect(await vault.accountedQuote()).to.equal(WAD);
    });

    it("advances the baseline by the delta only, never the raw balance", async () => {
      await send(WAD);
      // Second payment: newRevenue must be 1 WAD, baseline 2 WAD — not 2 and 2.
      await expect(send(WAD)).to.emit(vault, "RevenueRecognized").withArgs(WAD, 2n * WAD);
      expect(await vault.accountedQuote()).to.equal(2n * WAD);
    });

    it("treats a spurious zero-value ping as a silent no-op", async () => {
      await send(WAD);
      // Flap pings the same wallet more than once per dispatch, and anyone may
      // call receive(). A revert here would make Flap's dispatch of TORII fail.
      await expect(anyone.sendTransaction({ to: await vault.getAddress(), value: 0 })).to.not.be
        .reverted;
      expect(await vault.accountedQuote()).to.equal(WAD);
    });

    it("recognises funds that arrived with no wake call, via sync()", async () => {
      // A direct transfer from a contract-less path still lands in receive(), so
      // force an unsynced balance the way a selfdestruct or coinbase would.
      await setBalance(await vault.getAddress(), WAD);
      expect(await vault.accountedQuote()).to.equal(0n);

      await expect(vault.connect(anyone).sync())
        .to.emit(vault, "RevenueRecognized")
        .withArgs(WAD, WAD);
      expect(await vault.accountedQuote()).to.equal(WAD);
    });
  });

  describe("forwarding", () => {
    it("forwards recognised revenue to the Treasury and zeroes the baseline", async () => {
      await send(WAD);
      await expect(vault.connect(anyone).forwardQuote())
        .to.emit(vault, "Forwarded")
        .withArgs(WAD);

      expect(await treasury.funded()).to.equal(WAD);
      expect(await vault.accountedQuote()).to.equal(0n);
      expect(await vault.cumulativeForwarded()).to.equal(WAD);
    });

    it("is permissionless — any caller can push value to the one fixed destination", async () => {
      await send(WAD);
      await expect(vault.connect(rescue).forwardQuote()).to.not.be.reverted;
      expect(await treasury.funded()).to.equal(WAD);
    });

    it("reverts when there is nothing to forward", async () => {
      await expect(vault.connect(anyone).forwardQuote()).to.be.revertedWith(
        "ToriiVault: nothing to forward"
      );
    });

    /**
     * THE DEADLOCK REGRESSION.
     *
     * Flap's spec calls a baseline left above the real balance "the single most
     * dangerous mistake a V3 vault can make": `bal <= accountedQuote` then holds
     * forever and the vault stops recognising revenue permanently. This asserts
     * the vault keeps working across a full round trip.
     */
    it("keeps recognising revenue after a forward (no baseline deadlock)", async () => {
      await send(WAD);
      await vault.connect(anyone).forwardQuote();
      expect(await vault.accountedQuote()).to.equal(0n);

      await expect(send(2n * WAD))
        .to.emit(vault, "RevenueRecognized")
        .withArgs(2n * WAD, 2n * WAD);

      await vault.connect(anyone).forwardQuote();
      expect(await treasury.funded()).to.equal(3n * WAD);

      // And a third cycle, to prove it is not a one-shot recovery.
      await send(WAD);
      await vault.connect(anyone).forwardQuote();
      expect(await treasury.funded()).to.equal(4n * WAD);
    });

    it("does not zero the baseline when the Treasury refuses the funds", async () => {
      const bad = await (await ethers.getContractFactory("RevertingFundSink")).deploy();
      const v2 = await (await ethers.getContractFactory("ToriiVault")).deploy(
        await bad.getAddress(),
        await token.getAddress(),
        ethers.ZeroAddress,
        await router.getAddress()
      );
      await anyone.sendTransaction({ to: await v2.getAddress(), value: WAD });

      await expect(v2.connect(anyone).forwardQuote()).to.be.reverted;
      // The whole call reverted, so the baseline is intact and the funds are
      // still forwardable once the destination works again.
      expect(await v2.accountedQuote()).to.equal(WAD);
    });
  });

  describe("convertAndForward — the post-graduation token leg", () => {
    const TOKENS = 1000n * WAD;

    beforeEach(async () => {
      await token.mint(await vault.getAddress(), TOKENS);
    });

    it("sells TORII for BNB and forwards the proceeds to the Treasury", async () => {
      const expected = TOKENS / 1000n; // rate is 0.001 BNB per token
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;

      await expect(vault.connect(anyone).convertAndForward(0, 1n, deadline))
        .to.emit(vault, "Converted")
        .withArgs(TOKENS, expected);

      expect(await treasury.funded()).to.equal(expected);
      expect(await vault.accountedQuote()).to.equal(0n);
      expect(await vault.cumulativeConverted()).to.equal(TOKENS);
      expect(await token.balanceOf(await vault.getAddress())).to.equal(0n);
    });

    it("forwards the token proceeds together with pre-existing BNB revenue", async () => {
      await send(WAD); // bonding-curve-era BNB tax already sitting in the vault
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;

      await vault.connect(anyone).convertAndForward(0, 1n, deadline);
      expect(await treasury.funded()).to.equal(WAD + TOKENS / 1000n);
    });

    it("honours the caller-supplied slippage bound", async () => {
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;
      const tooMuch = TOKENS; // demand 1 BNB per token
      await expect(
        vault.connect(anyone).convertAndForward(0, tooMuch, deadline)
      ).to.be.revertedWith("MockRouter: INSUFFICIENT_OUTPUT_AMOUNT");
    });

    it("rejects a passed deadline and a zero slippage bound", async () => {
      const past = (await ethers.provider.getBlock("latest"))!.timestamp - 1;
      await expect(vault.connect(anyone).convertAndForward(0, 1n, past)).to.be.revertedWith(
        "ToriiVault: deadline passed"
      );

      const ok = (await ethers.provider.getBlock("latest"))!.timestamp + 600;
      await expect(vault.connect(anyone).convertAndForward(0, 0, ok)).to.be.revertedWith(
        "ToriiVault: minQuoteOut required"
      );
    });

    it("reverts when asked to sell more than it holds", async () => {
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;
      await expect(
        vault.connect(anyone).convertAndForward(TOKENS + 1n, 1n, deadline)
      ).to.be.revertedWith("ToriiVault: amount exceeds balance");
    });

    it("survives a fee-on-transfer token, which is the realistic case", async () => {
      // TORII is itself a tax token: less arrives at the pair than was sent.
      await token.setTaxBps(500);
      await router.setTaxBps(0);
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;

      await expect(vault.connect(anyone).convertAndForward(0, 1n, deadline)).to.not.be.reverted;
      expect(await treasury.funded()).to.be.greaterThan(0n);
      // Nothing left approved to the router after a partial spend.
      expect(await token.allowance(await vault.getAddress(), await router.getAddress())).to.equal(0n);
    });
  });

  describe("Flap discovery surface", () => {
    it("declares native BNB as the quote token, stably and without reverting", async () => {
      expect(await vault.vaultQuoteToken()).to.equal(ethers.ZeroAddress);
      expect(await vault.vaultSpecVersion()).to.equal("v3");
    });

    it("returns a non-empty description and UI schema covering every public method", async () => {
      expect(await vault.description()).to.not.equal("");

      const schema = await vault.vaultUISchema();
      expect(schema.vaultType).to.equal("ToriiReserveVault");
      expect(schema.description).to.not.equal("");

      const names = schema.methods.map((m: any) => m.name);
      expect(names).to.include.members([
        "pendingQuote",
        "pendingTaxToken",
        "cumulativeForwarded",
        "forwardQuote",
        "convertAndForward",
      ]);
      for (const m of schema.methods) {
        expect(m.name).to.not.equal("");
        expect(m.description).to.not.equal("");
      }
    });
  });

  describe("Flap rule 005 — receive() gas budget", () => {
    it("stays far below the 1,000,000 gas cap on a first payment", async () => {
      const tx = await anyone.sendTransaction({ to: await vault.getAddress(), value: WAD });
      const rc = await tx.wait();
      expect(rc!.gasUsed).to.be.lessThan(1_000_000n);
    });

    it("stays below the cap on a spurious zero-value ping", async () => {
      await send(WAD);
      const tx = await anyone.sendTransaction({ to: await vault.getAddress(), value: 0 });
      const rc = await tx.wait();
      expect(rc!.gasUsed).to.be.lessThan(1_000_000n);
    });
  });

  describe("Flap rule 009 — Guardian emergency controls", () => {
    let guardian: HardhatEthersSigner;

    beforeEach(async () => {
      await impersonateAccount(GUARDIAN_56);
      await setBalance(GUARDIAN_56, RICH);
      guardian = await ethers.getSigner(GUARDIAN_56);
    });

    it("lets only the Guardian drain native currency", async () => {
      await send(WAD);
      await expect(
        vault.connect(anyone).emergencyWithdrawNative(rescue.address)
      ).to.be.revertedWith("ToriiVault: not guardian");

      await expect(vault.connect(guardian).emergencyWithdrawNative(rescue.address))
        .to.emit(vault, "EmergencyWithdrawNative")
        .withArgs(rescue.address, WAD);
    });

    it("resets the baseline on an emergency drain, so the vault does not deadlock", async () => {
      await send(WAD);
      await vault.connect(guardian).emergencyWithdrawNative(rescue.address);
      expect(await vault.accountedQuote()).to.equal(0n);

      // Still able to recognise and forward afterwards.
      await send(WAD);
      expect(await vault.accountedQuote()).to.equal(WAD);
      await vault.connect(anyone).forwardQuote();
      expect(await treasury.funded()).to.equal(WAD);
    });

    it("lets only the Guardian recover a stuck ERC-20", async () => {
      await token.mint(await vault.getAddress(), 100n * WAD);
      await expect(
        vault.connect(anyone).emergencyWithdrawToken(await token.getAddress(), rescue.address)
      ).to.be.revertedWith("ToriiVault: not guardian");

      await vault.connect(guardian).emergencyWithdrawToken(await token.getAddress(), rescue.address);
      expect(await token.balanceOf(rescue.address)).to.equal(100n * WAD);
    });

    it("rejects the zero address as a rescue destination", async () => {
      await send(WAD);
      await expect(
        vault.connect(guardian).emergencyWithdrawNative(ethers.ZeroAddress)
      ).to.be.revertedWith("Zero address");
    });
  });

  describe("construction", () => {
    it("refuses an ERC-20 quote, which this vault does not account for", async () => {
      await expect(
        (await ethers.getContractFactory("ToriiVault")).deploy(
          await treasury.getAddress(),
          await token.getAddress(),
          await token.getAddress(), // non-native quote
          await router.getAddress()
        )
      ).to.be.revertedWith("ToriiVault: quote must be native");
    });

    it("refuses zero addresses", async () => {
      const F = await ethers.getContractFactory("ToriiVault");
      await expect(
        F.deploy(ethers.ZeroAddress, await token.getAddress(), ethers.ZeroAddress, await router.getAddress())
      ).to.be.revertedWith("ToriiVault: zero treasury");
      await expect(
        F.deploy(await treasury.getAddress(), ethers.ZeroAddress, ethers.ZeroAddress, await router.getAddress())
      ).to.be.revertedWith("ToriiVault: zero tax token");
    });
  });
});

describe("ToriiVaultFactory", () => {
  before(async function () {
    await skipUnlessFlapChain(this);
  });

  let deployer: HardhatEthersSigner, anyone: HardhatEthersSigner;
  let factory: any, treasury: any, router: any, token: any;

  // flap/VaultFactoryBaseV2.sol, chain 56.
  const VAULT_PORTAL_56 = "0x90497450f2a706f1951b5bdda52B4E5d16f34C06";

  const launchData = (over: Partial<Record<string, any>> = {}) => {
    const d = {
      tokenVersion: 3,
      quoteToken: ethers.ZeroAddress,
      buyTaxRate: 500,
      sellTaxRate: 500,
      vaultBps: 10_000,
      deflationBps: 0,
      dividendBps: 0,
      lpBps: 0,
      dividendToken: ethers.ZeroAddress,
      minimumShareBalance: 0,
      ...over,
    };
    return ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(uint8,address,uint16,uint16,uint16,uint16,uint16,uint16,address,uint256)"],
      [[
        d.tokenVersion, d.quoteToken, d.buyTaxRate, d.sellTaxRate, d.vaultBps,
        d.deflationBps, d.dividendBps, d.lpBps, d.dividendToken, d.minimumShareBalance,
      ]]
    );
  };

  beforeEach(async () => {
    [deployer, anyone] = await ethers.getSigners();
    treasury = await (await ethers.getContractFactory("MockFundSink")).deploy();
    token = await (await ethers.getContractFactory("MockTaxToken")).deploy(0);
    router = await (await ethers.getContractFactory("MockPancakeRouter")).deploy(WBNB, WAD / 1000n);
    factory = await (await ethers.getContractFactory("ToriiVaultFactory")).deploy(
      await treasury.getAddress(),
      await router.getAddress()
    );
  });

  it("only the VaultPortal may mint vaults", async () => {
    await expect(
      factory.connect(anyone).newVault(await token.getAddress(), ethers.ZeroAddress, anyone.address, "0x")
    ).to.be.revertedWith("ToriiVaultFactory: not vault portal");
  });

  it("mints a vault bound to the fixed Treasury when called by the portal", async () => {
    await impersonateAccount(VAULT_PORTAL_56);
    await setBalance(VAULT_PORTAL_56, RICH);
    const portal = await ethers.getSigner(VAULT_PORTAL_56);

    const tx = await factory
      .connect(portal)
      .newVault(await token.getAddress(), ethers.ZeroAddress, anyone.address, "0x");
    const rc = await tx.wait();
    const ev = rc!.logs
      .map((l: any) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e && e.name === "VaultCreated");

    expect(ev).to.not.equal(undefined);
    const vault = await ethers.getContractAt("ToriiVault", ev.args.vault);
    expect(await vault.treasury()).to.equal(await treasury.getAddress());
    expect(await vault.taxToken()).to.equal(await token.getAddress());
    expect(await vault.vaultQuoteToken()).to.equal(ethers.ZeroAddress);
  });

  it("supports only the native quote token", async () => {
    expect(await factory.isQuoteTokenSupported(ethers.ZeroAddress)).to.equal(true);
    expect(await factory.isQuoteTokenSupported(await token.getAddress())).to.equal(false);
  });

  it("reports the v2.3 spec so the V3 validation flow applies", async () => {
    expect(await factory.factorySpecVersion()).to.equal("v2.3");
  });

  describe("launch guard", () => {
    it("accepts a correctly configured 5% launch", async () => {
      const [ok, reason] = await factory.onBeforeLaunch(launchData());
      expect(ok).to.equal(true);
      expect(reason).to.equal("");
    });

    it("rejects any tax rate other than 5% on either side", async () => {
      for (const over of [{ buyTaxRate: 300 }, { sellTaxRate: 1000 }, { buyTaxRate: 100, sellTaxRate: 100 }]) {
        const [ok, reason] = await factory.onBeforeLaunch(launchData(over));
        expect(ok).to.equal(false);
        expect(reason).to.contain("5% tax");
      }
    });

    it("rejects a launch that diverts part of the tax away from the reserve", async () => {
      const [ok, reason] = await factory.onBeforeLaunch(launchData({ vaultBps: 8_000 }));
      expect(ok).to.equal(false);
      expect(reason).to.contain("100% of the tax");
    });

    it("rejects a non-native quote token", async () => {
      const [ok, reason] = await factory.onBeforeLaunch(
        launchData({ quoteToken: "0x55d398326f99059fF775485246999027B3197955" })
      );
      expect(ok).to.equal(false);
      expect(reason).to.contain("native BNB");
    });
  });
});

describe("ToriiDistributor (Suits removed)", () => {
  let anyone: HardhatEthersSigner;
  let dist: any, sink: any;

  beforeEach(async () => {
    [, anyone] = await ethers.getSigners();
    sink = await (await ethers.getContractFactory("MockRewardSink")).deploy();
    dist = await (await ethers.getContractFactory("ToriiDistributor")).deploy(await sink.getAddress());
  });

  it("routes the entire amount to stTORII", async () => {
    await sink.setSupply(WAD);
    await expect(dist.connect(anyone).distribute({ value: WAD }))
      .to.emit(dist, "Distributed")
      .withArgs(WAD);
    expect(await sink.received()).to.equal(WAD);
    expect(await dist.cumulativeToAgora()).to.equal(WAD);
  });

  it("previews the full amount, since there is no second sink", async () => {
    expect(await dist.preview(12345n)).to.equal(12345n);
  });

  it("refuses to distribute when nobody is staking, leaving income earmarked", async () => {
    await sink.setSupply(0);
    await expect(dist.connect(anyone).distribute({ value: WAD })).to.be.revertedWithCustomError(
      dist,
      "NoStakers"
    );
    expect(await sink.received()).to.equal(0n);
  });

  it("flushes an idle balance through the same rule", async () => {
    await sink.setSupply(WAD);
    await anyone.sendTransaction({ to: await dist.getAddress(), value: WAD });
    await dist.connect(anyone).flush();
    expect(await sink.received()).to.equal(WAD);
  });

  it("has no owner and therefore no privileged caller", async () => {
    expect((dist.interface as any).getFunction("owner")).to.equal(null);
    expect((dist.interface as any).getFunction("setSuitsBps")).to.equal(null);
  });
});
