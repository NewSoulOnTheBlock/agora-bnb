import { useCallback, useEffect, useRef, useState } from "react";
import { readSnapshot, type Snapshot } from "./reads";
import { readTaxHistory, readFloorHistory, findFloorRegressions, type TaxEvent, type FloorPoint } from "./history";
import { readBeefyPositions, totalDeployedWei, readOperatorHoldings, type BeefyPosition, type OperatorHoldings } from "./beefy";

type Async<T> = { data: T | null; loading: boolean; error: string | null };

/** Polls the composite snapshot. Cheap reads, so a short interval is fine. */
export function useSnapshot(intervalMs = 15_000) {
  const [state, setState] = useState<Async<Snapshot>>({ data: null, loading: true, error: null });
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const s = await readSnapshot();
      if (alive.current) setState({ data: s, loading: false, error: null });
    } catch (e) {
      if (alive.current) {
        setState((p) => ({ data: p.data, loading: false, error: String((e as Error).message ?? e) }));
      }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh();
    const t = setInterval(refresh, intervalMs);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [refresh, intervalMs]);

  return { ...state, refresh };
}

/**
 * Log scans are many sequential RPC round-trips, so they are fetched once on
 * demand rather than polled — re-scanning several hundred thousand blocks every
 * 15 seconds would hammer a public endpoint for almost no new data.
 */
export function useTaxHistory(poolId: string | null | undefined, enabled = true) {
  const [state, setState] = useState<Async<TaxEvent[]>>({ data: null, loading: false, error: null });

  useEffect(() => {
    if (!poolId || !enabled) return;
    let alive = true;
    setState({ data: null, loading: true, error: null });
    readTaxHistory(poolId)
      .then((d) => alive && setState({ data: d, loading: false, error: null }))
      .catch((e) => alive && setState({ data: null, loading: false, error: String(e?.message ?? e) }));
    return () => { alive = false; };
  }, [poolId, enabled]);

  return state;
}

export function useFloorHistory(enabled = true) {
  const [state, setState] = useState<Async<FloorPoint[]>>({ data: null, loading: false, error: null });
  const [regressions, setRegressions] = useState<FloorPoint[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setState({ data: null, loading: true, error: null });
    readFloorHistory()
      .then((d) => {
        if (!alive) return;
        setState({ data: d, loading: false, error: null });
        setRegressions(findFloorRegressions(d));
      })
      .catch((e) => alive && setState({ data: null, loading: false, error: String(e?.message ?? e) }));
    return () => { alive = false; };
  }, [enabled]);

  return { ...state, regressions };
}

/**
 * The operator's Beefy positions.
 *
 * Deployed corpus leaves `nav()`, so without this the dashboard shows a
 * treasury that looks emptied — right now NAV reads 0.02 ETH against 1.37 ETH
 * withdrawn — when the capital is simply working somewhere the Treasury cannot
 * see. Polled slowly: it is a registry sweep plus a per-vault read, and the
 * position does not move between blocks the way a price does.
 */
export function useBeefy(holder: string | null | undefined, intervalMs = 60_000) {
  const [state, setState] = useState<Async<BeefyPosition[]>>({ data: null, loading: true, error: null });

  useEffect(() => {
    if (!holder) return;
    let alive = true;
    const go = () =>
      readBeefyPositions(holder)
        .then((d) => alive && setState({ data: d, loading: false, error: null }))
        .catch((e) => alive && setState({ data: null, loading: false, error: String(e?.message ?? e) }));
    go();
    const t = setInterval(go, intervalMs);
    return () => { alive = false; clearInterval(t); };
  }, [holder, intervalMs]);

  return { ...state, total: state.data ? totalDeployedWei(state.data) : null };
}

/** The operator wallet's own ETH and AGORA, for reconciling withdrawals. */
export function useOperatorHoldings(
  holder: string | null | undefined,
  agoraToken: string,
  stAgoraVault: string,
  priceWad: bigint | null,
  intervalMs = 60_000
) {
  const [data, setData] = useState<OperatorHoldings | null>(null);

  useEffect(() => {
    if (!holder) return;
    let alive = true;
    const go = () =>
      readOperatorHoldings(holder, agoraToken, stAgoraVault, priceWad)
        .then((d) => alive && setData(d))
        .catch(() => alive && setData(null));
    go();
    const t = setInterval(go, intervalMs);
    return () => { alive = false; clearInterval(t); };
  }, [holder, agoraToken, stAgoraVault, priceWad, intervalMs]);

  return data;
}
