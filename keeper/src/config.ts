import "dotenv/config";
import { JsonRpcProvider, Wallet } from "ethers";

/**
 * Keeper configuration.
 *
 * ## The security property worth stating up front
 *
 * Every call this process makes is **permissionless**. `FeeSink.collect()`,
 * `Treasury.distributeIncome()` and `Treasury.realizeSurplus()` can be called
 * by anyone — they exist that way on purpose, because none of them chooses a
 * venue or moves principal out of the protocol. They only push value *along* a
 * path the contracts already fixed.
 *
 * So the keeper's key is not a privileged key. It pays gas and nothing else. If
 * it leaks, the attacker's best move is to call the same functions the keeper
 * was going to call. **Do not reuse the Treasury owner key here** — that key
 * can withdraw the corpus, and it has no business on a machine that runs
 * unattended.
 */

const req = (k: string): string => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`${k} is not set. Copy .env.example to .env and fill it in.`);
  return v;
};

export const RPC_URL = process.env.RH_RPC_URL?.trim() || "https://rpc.mainnet.chain.robinhood.com";
export const CHAIN_ID = Number(process.env.RH_CHAIN_ID ?? 4663);

/** Nothing is broadcast unless this is explicitly turned on. */
export const EXECUTE = process.env.KEEPER_EXECUTE === "1";

export const INTERVAL_S = Number(process.env.KEEPER_INTERVAL ?? 300);

/**
 * A job is skipped unless the value it moves is at least this many times the
 * gas it would cost. Without it the keeper happily burns 0.0002 ETH of gas to
 * sweep 0.0001 ETH of tax, which is a net loss to the very corpus it is meant
 * to be filling.
 */
export const MIN_RATIO = Number(process.env.KEEPER_MIN_RATIO ?? 3);

/** Verified on chain 4663. Same set the frontend uses. */
export const ADDR = {
  feeSink: "0xb8Bc3E208cAA463b96c0A62c23E88905a7CEbB7E",
  treasury: "0x7A3B8322dd85C6e9F24D3A0a8D66514ad0E26C5c",
  distributor: "0xf422916f139CB003B0FDC36edC73a816D17B914b",
  stakedAgora: "0x92dEbC6a1A8afE872EEb6aBac05DC3Fb1347D463",
  stakedSuits: "0xE76Cb0cc3EcA2959a8384A5a0Fe00A3EA0E5e1A3",
} as const;

export const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });

/** Only built when a key is present, so a dry run needs no key at all. */
export function wallet(): Wallet {
  return new Wallet(req("KEEPER_PRIVATE_KEY"), provider);
}

export function hasKey(): boolean {
  return !!process.env.KEEPER_PRIVATE_KEY?.trim();
}
