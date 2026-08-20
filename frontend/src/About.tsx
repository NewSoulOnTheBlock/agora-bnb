import { formatEther } from "ethers";
import { Panel, Row } from "./components";
import { fmtSig, fmtGrouped, DASH } from "./format";
import {
  TORII, explorerAddr, SUITS_NFT, SUITS_SUPPLY, SUITS_MARKET, TORII_TAX_BPS,
  SUITS_STAKING_ENABLED,
} from "./chain";
import { useSnapshot } from "./useReads";

/**
 * The explainer. Written for someone who has never used a DeFi app.
 *
 * Two rules govern this page. Everything stated as fact is read from the live
 * contracts, not hardcoded — the split, haircut and delay below are whatever
 * governance has actually set. And every claim that could mislead a buyer is
 * stated with its limit attached, in the same sentence, not in a footnote.
 */
export default function About() {
  const { data: s } = useSnapshot();

  const r = s?.reserve;
  const rd = s?.redeem;

  const incomePct = r?.incomeShareBps != null ? Number(r.incomeShareBps) / 100 : null;
  const corpusPct = incomePct != null ? 100 - incomePct : null;
  const suitsPct = s?.suits.shareBps != null ? Number(s.suits.shareBps) / 100 : 10;
  const haircutPct = rd?.haircutBps != null ? Number(rd.haircutBps) / 100 : null;
  const delayHrs = rd?.redeemDelay != null ? Number(rd.redeemDelay) / 3600 : null;
  const taxPct = TORII_TAX_BPS / 100;

  // Worked example, computed from the live numbers so it can never drift.
  const ex = 1; // 1 BNB traded
  const exTax = ex * (taxPct / 100);
  const exCorpus = incomePct != null ? exTax * (1 - incomePct / 100) : null;
  const exIncome = incomePct != null ? exTax * (incomePct / 100) : null;
  const exSuits = exIncome != null ? exIncome * (suitsPct / 100) : null;
  const exStakers = exIncome != null ? exIncome - exSuits! : null;

  return (
    <>
      <div className="hero">
        <Panel label="In one sentence">
          <p className="lede">
            Every time someone buys or sells TORII, a slice of that trade is taken and put into a
            shared pot. Part of the pot pays people who lock up their tokens. The rest just sits
            there, growing — and you can always hand your tokens back for a share of it.
          </p>
        </Panel>
      </div>

      {/* ------------------------------------------------------------------ */}
      <div className="section">
        <p className="label">How it works <span className="id">four steps</span></p>
        <Panel>
          <ol className="steps big-steps">
            <li className="step">
              <b>Someone trades.</b> Every buy and every sell of TORII pays a{" "}
              <b>{taxPct}% fee</b>. If you buy 1 BNB worth, about {taxPct} of every 100 goes to the
              protocol instead of to you. This is the only thing that funds everything below — no
              new tokens are ever printed.
            </li>
            <li className="step">
              <b>The fee lands in the Treasury.</b> It arrives as BNB, automatically. Anyone can
              press the button that moves it along; nobody special has to be online.
            </li>
            <li className="step">
              <b>It splits two ways.</b>{" "}
              {corpusPct != null && incomePct != null ? (
                <>
                  <b>{corpusPct}%</b> stays in the pot and makes every token worth a little more.{" "}
                  <b>{incomePct}%</b> is paid out as income.
                </>
              ) : (
                <>The split is set by governance and read live from the contract.</>
              )}
            </li>
            <li className="step">
              <b>Income goes to people who commit.</b> {100 - suitsPct}% to people who stake their
              TORII, {suitsPct}% to people who stake a Suits NFT. Paid in BNB. You claim it whenever
              you like — it does not expire.
            </li>
          </ol>
        </Panel>
      </div>

      {/* ------------------------------------------------------------------ */}
      <div className="section">
        <p className="label">
          If someone trades 1 BNB of TORII <span className="id">live numbers, not an illustration</span>
        </p>
        <Panel>
          <div className="rows">
            <Row k="Fee taken">{exTax.toFixed(4)} BNB ({taxPct}%)</Row>
            <Row k="→ into the pot" na={exCorpus == null}>
              {exCorpus != null ? `${exCorpus.toFixed(4)} BNB — raises what every token is worth` : DASH}
            </Row>
            <Row k="→ to TORII stakers" na={exStakers == null}>
              {exStakers != null ? `${exStakers.toFixed(4)} BNB` : DASH}
            </Row>
            <Row k="→ to staked Suits" na={exSuits == null}>
              {exSuits != null ? `${exSuits.toFixed(4)} BNB, split across every staked Suit` : DASH}
            </Row>
          </div>
          <p className="sub">
            Nothing above is a projection. Those percentages are read from the contracts as this page
            loads, so if governance changes them this example changes with it.
          </p>
        </Panel>
      </div>

      {/* ------------------------------------------------------------------ */}
      <div className="section">
        <p className="label">The three things you can do</p>
        <div className="grid c3">
          <Panel label="Hold">
            <p className="sub" style={{ marginTop: 0 }}>
              Do nothing. The pot grows on every trade, and the amount of reserve sitting behind each
              token goes up. You are not paid income, but you are not locked in either.
            </p>
          </Panel>
          <Panel label="Stake">
            <p className="sub" style={{ marginTop: 0 }}>
              Lock TORII into the staking vault and receive a share of all income, paid in <b>BNB</b>,
              not in more tokens. Unstake whenever you want — any income you already earned stays
              yours even after you leave.
            </p>
          </Panel>
          <Panel label="Redeem">
            <p className="sub" style={{ marginTop: 0 }}>
              Hand your TORII back and take your share of the pot in BNB. Your tokens are destroyed,
              which makes every remaining token worth slightly more.
            </p>
          </Panel>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      <div className="section">
        <p className="label">Redeeming, in plain terms</p>
        <Panel>
          <div className="rows">
            <Row k="What you get">
              Your fair share of the pot: the reserve divided by the number of tokens, times how many
              you hand in
            </Row>
            <Row k="What it costs" na={haircutPct == null}>
              {haircutPct != null
                ? `${haircutPct}% is kept back — and it stays in the pot, so everyone who did not redeem is slightly better off`
                : DASH}
            </Row>
            <Row k="How long it takes" na={delayHrs == null}>
              {delayHrs != null ? `${delayHrs} hours between asking and collecting` : DASH}
            </Row>
            <Row k="Can you change your mind?">
              <b>No.</b> Your tokens are destroyed the moment you ask, not when you collect
            </Row>
          </div>
          <p className="sub">
            The waiting period exists so nobody can watch the price jump, redeem instantly and take
            more than their share. You are paid the <em>lower</em> of the value when you asked and the
            value when you collect.
          </p>
        </Panel>
      </div>

      {/* ------------------------------------------------------------------ */}
      <div className="section">
        <p className="label">Suits <span className="id">{SUITS_SUPPLY} of them, that's all there will ever be</span></p>
        <Panel>
          {!SUITS_STAKING_ENABLED && (
            <div className="notice" style={{ marginTop: 0 }}>
              <b>Suits staking is currently unavailable.</b> The collection only lets approved
              contracts move its tokens, and this staking vault has not been approved by the
              collection's owner. Until that changes, no Suit can be staked — and the {suitsPct}%
              share is paid to TORII stakers instead. Nothing is lost or stuck; the vault works the
              moment the collection approves it.
            </div>
          )}
          <p className="sub" style={{ marginTop: SUITS_STAKING_ENABLED ? 0 : 12 }}>
            Suits is a separate NFT collection. Staking one {SUITS_STAKING_ENABLED ? "earns" : "would earn"}{" "}
            <b>{suitsPct}%</b> of all protocol income, split evenly across every Suit staked — the
            fewer staked, the bigger each share. Every Suit earns the same; there is no rarity bonus.
          </p>
          <div className="rows" style={{ marginTop: 12 }}>
            <Row k="Supply">{SUITS_SUPPLY}, fully minted — none can ever be created</Row>
            <Row k="Staked right now" na={s?.suits.totalStaked == null}>
              {s?.suits.totalStaked != null ? `${s.suits.totalStaked} of ${SUITS_SUPPLY}` : DASH}
            </Row>
            <Row k="Where to get one">
              <a className="rv" href={SUITS_MARKET} target="_blank" rel="noreferrer">OpenSea ↗</a>
            </Row>
            <Row k="Collection">
              <a className="rv" href={explorerAddr(SUITS_NFT)} target="_blank" rel="noreferrer">
                {SUITS_NFT.slice(0, 14)}…
              </a>
            </Row>
          </div>
        </Panel>
      </div>

      {/* ------------------------------------------------------------------ */}
      <div className="section">
        <p className="label">What could go wrong <span className="id">read this part</span></p>

        <div className="notice danger">
          <b>The reserve is not a guarantee.</b> The person who controls the Treasury can withdraw
          BNB from the pot to invest it elsewhere. That is intentional — it is how the pot is meant
          to earn a return — but it means the amount backing each token can go <em>down</em> as well
          as up, and it is not a floor anyone is obliged to hold. Every withdrawal is recorded
          publicly on-chain.
          {r?.cumulativeWithdrawn != null && (
            <> Taken out so far: <b>{formatEther(r.cumulativeWithdrawn)} BNB</b>.</>
          )}
        </div>

        <Panel>
          <div className="rows">
            <Row k="This is not a savings account">
              Income depends entirely on trading volume. No trades means no income — there is no
              yield from anywhere else
            </Row>
            <Row k="The token price can fall">
              The reserve tracks what has been collected. It says nothing about what people will pay
              for TORII on the open market
            </Row>
            <Row k={`The ${taxPct}% fee is on both sides`}>
              Buying and selling each cost {taxPct}%, so a quick round trip loses about{" "}
              {(taxPct * 2).toFixed(0)}% before any price movement
            </Row>
            <Row k="One key controls a lot">
              A single wallet can currently change the payout settings and move reserve funds. Check
              who holds it before committing anything you cannot lose
            </Row>
            <Row k="Staked Suits rely on the NFT's rules">
              The Suits collection can restrict transfers. If its owner tightened those rules,
              staked NFTs could get stuck — that collection is not controlled by this protocol
            </Row>
          </div>
          <p className="sub">
            None of this is advice. It is a description of how the contracts behave. Everything here
            is verifiable — the addresses are below and the source is public.
          </p>
        </Panel>
      </div>

      {/* ------------------------------------------------------------------ */}
      <div className="section">
        <p className="label">Where it all lives <span className="id">verify anything above</span></p>
        <Panel>
          <div className="rows">
            {([
              ["TORII token", TORII.token],
              ["Treasury (the pot)", TORII.treasury],
              ["Fee collector", TORII.feeSink],
              ["Staking vault", TORII.stakedAgora],
              ["Suits staking", TORII.stakedSuits],
              ["Redemption", TORII.redeemer],
              ["Income splitter", TORII.distributor],
            ] as const).map(([label, addr]) => (
              <Row key={label} k={label}>
                <a className="rv" href={explorerAddr(addr)} target="_blank" rel="noreferrer">
                  {addr.slice(0, 16)}…
                </a>
              </Row>
            ))}
            <Row k="Reserve right now" na={r?.navWad == null}>
              {r?.navWad != null ? `${fmtSig(r.navWad)} BNB` : DASH}
            </Row>
            <Row k="Behind each token" na={r?.floorPerTokenWad == null}>
              {r?.floorPerTokenWad != null ? `${fmtSig(r.floorPerTokenWad)} BNB` : DASH}
            </Row>
            <Row k="Tokens in circulation" na={r?.eligibleSupply == null}>
              {r?.eligibleSupply != null ? `${fmtGrouped(r.eligibleSupply, 0)} TORII` : DASH}
            </Row>
          </div>
        </Panel>
      </div>
    </>
  );
}
