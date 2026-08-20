import { useState } from "react";
import Layout, { DISABLED_TABS, type Tab } from "./Layout";
import About from "./About";
import Floor from "./Floor";
import Deployed from "./Deployed";
import Trade from "./Trade";
import Stake from "./Stake";
import Redeem from "./Redeem";
import { useWallet } from "./eth";

const VALID: Tab[] = ["about", "floor", "deployed", "trade", "stake", "redeem"];

function initialTab(): Tab {
  const h = window.location.hash.replace("#", "") as Tab;
  // A disabled route must not be reachable by pasting its hash either — the
  // action behind it cannot succeed, so landing there would only produce a
  // reverted transaction.
  if (!VALID.includes(h) || DISABLED_TABS.has(h)) return "floor";
  return h;
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
      {tab === "about" && <About />}
      {tab === "floor" && <Floor />}
      {tab === "deployed" && <Deployed />}
      {tab === "trade" && <Trade wallet={wallet} />}
      {tab === "stake" && <Stake wallet={wallet} />}
      {tab === "redeem" && <Redeem wallet={wallet} />}
    </Layout>
  );
}
