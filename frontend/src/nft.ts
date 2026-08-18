import { AGORA, SUITS_NFT, SUITS_SUPPLY, ZERO } from "./chain";
import { multiRead, asStr, type MCall } from "./multicall";

/**
 * Listing a wallet's Suits, on a collection that cannot list them.
 *
 * ## The problem
 *
 * Suits is not `ERC721Enumerable` — there is no `tokenOfOwnerByIndex` and no
 * `tokenByIndex`. That is why the Suits page asks holders to *type* their token
 * IDs: without an indexer there was no other way, and this chain has no NFT API
 * to fall back on.
 *
 * ## Why brute force is the right answer here
 *
 * The collection is 1111 tokens, fully minted, and fixed. So the whole
 * ownership table is 1111 `ownerOf` reads, which Multicall3 answers in three
 * requests — measured at **1.4s for all 1111** against the public endpoint.
 * An indexer would be faster and would also be a second source of truth that
 * can disagree with the chain; this cannot, because it *is* the chain.
 *
 * That only works because the supply is small and immutable. It would be the
 * wrong shape for a 10k collection and the wrong shape for an open mint.
 *
 * ## Staked tokens
 *
 * A staked Suit is owned by the vault, not by its staker, so the ownership
 * sweep finds it under the vault's address. The vault's `stakerOf` then says
 * whose it is. Only the vault-held IDs need that second pass, which is normally
 * a handful of calls and often none at all.
 */

export type Suit = {
  id: number;
  /** Held directly in the wallet, or held by the vault on the wallet's behalf. */
  state: "yours" | "staked";
};

export type SuitsInventory = {
  suits: Suit[];
  /** Whether the vault may already move this wallet's tokens. */
  approved: boolean | null;
  /** Total tokens the sweep resolved — a sanity check on the read itself. */
  resolved: number;
};

/** Multicall3 is happy with far more, but a smaller batch fails more cheaply. */
const CHUNK = 400;

const OWNER_OF = "function ownerOf(uint256) view returns (address)";
const STAKER_OF = "function stakerOf(uint256) view returns (address)";
const APPROVED_FOR_ALL = "function isApprovedForAll(address,address) view returns (bool)";

/**
 * `aggregate3Strict` rather than the forgiving version, deliberately.
 *
 * A soft failure decodes every entry to `null`, and a `null` owner is
 * indistinguishable from "not yours" — the sweep would report an empty folder
 * for a wallet full of Suits. That exact failure already shipped once on the
 * Beefy registry and read as a finding rather than an outage. An empty folder
 * here has to mean the chain said so.
 */
async function readAll(calls: MCall[]): Promise<(unknown[] | null)[]> {
  const out: (unknown[] | null)[] = [];
  for (let i = 0; i < calls.length; i += CHUNK) {
    out.push(...(await multiRead(calls.slice(i, i + CHUNK), { strict: true })));
  }
  return out;
}

/**
 * One sweep per wallet per session, unless something changed it.
 *
 * Reopening the folder should be instant: 1111 owners is ~2.5s in the browser
 * once contention with the page's own readers is counted, and nothing about the
 * answer goes stale on its own — a Suit only moves when someone moves it. So
 * the cache is cleared explicitly after a stake or unstake, and by Refresh.
 */
const inventoryCache = new Map<string, SuitsInventory>();

export function forgetSuitsInventory(account?: string) {
  if (account) inventoryCache.delete(account.toLowerCase());
  else inventoryCache.clear();
}

export async function readSuitsInventory(
  account: string,
  opts?: { fresh?: boolean }
): Promise<SuitsInventory> {
  const me = account.toLowerCase();

  const hit = inventoryCache.get(me);
  if (hit && !opts?.fresh) return hit;

  const vault = AGORA.stakedSuits;
  const hasVault = vault !== ZERO;

  const owners = await readAll(
    Array.from({ length: SUITS_SUPPLY }, (_, i) => ({
      target: SUITS_NFT,
      fragment: OWNER_OF,
      args: [i + 1],
    }))
  );

  const suits: Suit[] = [];
  const inVault: number[] = [];
  let resolved = 0;

  owners.forEach((r, i) => {
    const owner = asStr(r);
    if (!owner) return;
    resolved++;
    const id = i + 1;
    if (owner.toLowerCase() === me) suits.push({ id, state: "yours" });
    else if (hasVault && owner.toLowerCase() === vault.toLowerCase()) inVault.push(id);
  });

  // Second pass, only over what the vault holds: whose stake is it?
  if (inVault.length) {
    const stakers = await readAll(
      inVault.map((id) => ({ target: vault, fragment: STAKER_OF, args: [id] }))
    );
    stakers.forEach((r, k) => {
      const who = asStr(r);
      if (who && who.toLowerCase() === me) suits.push({ id: inVault[k], state: "staked" });
    });
  }

  suits.sort((a, b) => a.id - b.id);

  const approved = hasVault
    ? await multiRead([
        { target: SUITS_NFT, fragment: APPROVED_FOR_ALL, args: [account, vault] },
      ])
        .then((r) => (r[0] ? Boolean(r[0][0]) : null))
        .catch(() => null)
    : null;

  const inv = { suits, approved, resolved };
  inventoryCache.set(me, inv);
  return inv;
}

/* --------------------------------------------------------------------------
   Metadata
   --------------------------------------------------------------------------
   `tokenURI` is `ipfs://<cid>/<id>`, so every thumbnail is a gateway fetch and
   a second one for the image. Measured cold: ~5s for the metadata and ~5s for
   a 1.28 MB PNG, which is why thumbnails are opt-in and the folder opens in
   list view. A Win98 folder showing file icons is not a degraded experience —
   it is the period-correct one — so the icon view is the default rather than a
   fallback, and images are something the reader asks for.
-------------------------------------------------------------------------- */

/** Public gateways, tried in order. Pinata was the only one serving this CID. */
const GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
];

export function gatewayUrl(uri: string, gateway = 0): string {
  const g = GATEWAYS[Math.min(gateway, GATEWAYS.length - 1)];
  return uri.startsWith("ipfs://") ? g + uri.slice("ipfs://".length) : uri;
}

export type SuitMeta = {
  name: string;
  image: string;
  attributes: { trait_type: string; value: string }[];
};

const metaCache = new Map<number, SuitMeta | null>();

/** Metadata for one token, cached for the session. Null when unreachable. */
export async function readSuitMeta(id: number): Promise<SuitMeta | null> {
  if (metaCache.has(id)) return metaCache.get(id) ?? null;

  const r = await multiRead([
    { target: SUITS_NFT, fragment: "function tokenURI(uint256) view returns (string)", args: [id] },
  ]);
  const uri = asStr(r[0]);
  if (!uri) {
    metaCache.set(id, null);
    return null;
  }

  for (let g = 0; g < GATEWAYS.length; g++) {
    try {
      const res = await fetch(gatewayUrl(uri, g));
      if (!res.ok) continue;
      const j = await res.json();
      const meta: SuitMeta = {
        name: String(j.name ?? `Suits #${id}`),
        image: String(j.image ?? ""),
        attributes: Array.isArray(j.attributes) ? j.attributes : [],
      };
      metaCache.set(id, meta);
      return meta;
    } catch {
      // Try the next gateway.
    }
  }

  metaCache.set(id, null);
  return null;
}


/* --------------------------------------------------------------------------
   Thumbnail loading
   -------------------------------------------------------------------------- */

/**
 * Load an image and only report it once it has actually decoded.
 *
 * The first version bound the gateway URL straight into `<img src>`, which
 * makes the browser paint an empty box for as long as the download takes — and
 * these are 1280x1280 PNGs, 1.28 MB each, displayed at 44 pixels. Twenty-nine
 * of them at once left most tiles as grey rectangles that read as broken art
 * rather than as pending art. Preloading fixes that: the file icon stays until
 * there is a real picture to replace it with, which is also what a Win98 folder
 * did while it was building thumbnails.
 *
 * Four at a time, because the gateway is the bottleneck and thirty parallel
 * multi-megabyte requests only makes every one of them slower.
 */
const MAX_IMAGE_LOADS = 4;
let imageLoads = 0;
const imageQueue: (() => void)[] = [];

function releaseImageSlot() {
  imageLoads--;
  imageQueue.shift()?.();
}

export function loadImage(uri: string): Promise<string | null> {
  return new Promise((resolve) => {
    const start = () => {
      imageLoads++;
      let gateway = 0;

      const attempt = () => {
        const url = gatewayUrl(uri, gateway);
        const img = new Image();
        img.onload = () => { releaseImageSlot(); resolve(url); };
        img.onerror = () => {
          gateway++;
          if (gateway < GATEWAYS.length) attempt();
          else { releaseImageSlot(); resolve(null); }
        };
        img.src = url;
      };

      attempt();
    };

    if (imageLoads >= MAX_IMAGE_LOADS) imageQueue.push(start);
    else start();
  });
}
