import { useState } from "react";
import Layout, { type Tab } from "./Layout";
import Floor from "./Floor";
import Trade from "./Trade";
import Stake from "./Stake";
import Suits from "./Suits";
import Redeem from "./Redeem";
import { useWallet } from "./eth";

const VALID: Tab[] = ["floor", "trade", "stake", "suits", "redeem"];

function initialTab(): Tab {
  const h = window.location.hash.replace("#", "") as Tab;
  return VALID.includes(h) ? h : "floor";
}

export default function App() {
  const [tab, setTabState] = useState<Tab>(initialTab);
  const wallet = useWallet();

  // Hash routing keeps tabs linkable without pulling in a router dependency.
  const setTab = (t: Tab) => {
    setTabState(t);
    window.location.hash = t;
  };

  return (
    <Layout tab={tab} setTab={setTab} wallet={wallet}>
      {tab === "floor" && <Floor />}
      {tab === "trade" && <Trade wallet={wallet} />}
      {tab === "stake" && <Stake wallet={wallet} />}
      {tab === "suits" && <Suits wallet={wallet} />}
      {tab === "redeem" && <Redeem wallet={wallet} />}
    </Layout>
  );
}
