import { BrowserProvider, type JsonRpcSigner } from "ethers";
import { useCallback, useEffect, useState } from "react";
import { CHAIN_ID, CHAIN_ID_HEX, CHAIN_PARAMS } from "./chain";

declare global {
  interface Window {
    ethereum?: {
      request: (a: { method: string; params?: unknown[] }) => Promise<any>;
      on?: (e: string, cb: (...a: any[]) => void) => void;
      removeListener?: (e: string, cb: (...a: any[]) => void) => void;
    };
  }
}

export type Wallet = {
  account: string | null;
  chainId: number | null;
  connecting: boolean;
  error: string | null;
  hasProvider: boolean;
  onCorrectChain: boolean;
  connect: () => Promise<void>;
  switchChain: () => Promise<void>;
  getSigner: () => Promise<JsonRpcSigner>;
};

export function useWallet(): Wallet {
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasProvider = typeof window !== "undefined" && !!window.ethereum;

  useEffect(() => {
    const eth = window.ethereum;
    if (!eth) return;
    // eth_accounts (not eth_requestAccounts) so we never trigger a popup on load.
    eth.request({ method: "eth_accounts" })
      .then((as: string[]) => as?.[0] && setAccount(as[0]))
      .catch(() => {});
    eth.request({ method: "eth_chainId" })
      .then((c: string) => setChainId(parseInt(c, 16)))
      .catch(() => {});

    const onAccounts = (as: string[]) => setAccount(as?.[0] ?? null);
    const onChain = (c: string) => setChainId(parseInt(c, 16));
    eth.on?.("accountsChanged", onAccounts);
    eth.on?.("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, []);

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setError("No injected wallet found.");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const as: string[] = await window.ethereum.request({ method: "eth_requestAccounts" });
      setAccount(as?.[0] ?? null);
      const c: string = await window.ethereum.request({ method: "eth_chainId" });
      setChainId(parseInt(c, 16));
    } catch (e: any) {
      setError(e?.message ?? "Wallet connection rejected.");
    } finally {
      setConnecting(false);
    }
  }, []);

  const switchChain = useCallback(async () => {
    if (!window.ethereum) return;
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: CHAIN_ID_HEX }],
      });
    } catch (e: any) {
      // 4902 = chain unknown to the wallet; offer to add it.
      if (e?.code === 4902) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [CHAIN_PARAMS],
          });
        } catch (e2: any) {
          setError(e2?.message ?? "Could not add Robinhood Chain.");
        }
      } else {
        setError(e?.message ?? "Could not switch network.");
      }
    }
  }, []);

  const getSigner = useCallback(async () => {
    if (!window.ethereum) throw new Error("No injected wallet.");
    const bp = new BrowserProvider(window.ethereum as any, CHAIN_ID);
    return bp.getSigner();
  }, []);

  return {
    account,
    chainId,
    connecting,
    error,
    hasProvider,
    onCorrectChain: chainId === CHAIN_ID,
    connect,
    switchChain,
    getSigner,
  };
}
