import { useCallback, useEffect, useRef, useState } from "react";
import { readSnapshot, type Snapshot } from "./reads";
import { readTaxHistory, readFloorHistory, findFloorRegressions, type TaxEvent, type FloorPoint } from "./history";

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
