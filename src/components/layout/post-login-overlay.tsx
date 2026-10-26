"use client";

import { useEffect, useState } from "react";
import { LoadingVeil } from "@/components/layout/loading-veil";

const FLAG_KEY = "ls-post-login";

export function PostLoginOverlay() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let flag: string | null = null;
    try {
      flag = sessionStorage.getItem(FLAG_KEY);
    } catch {
      return;
    }
    if (!flag) return;

    try {
      sessionStorage.removeItem(FLAG_KEY);
    } catch {}

    setVisible(true);

    const hide = () => setVisible(false);

    if (document.readyState === "complete") {
      const t = setTimeout(hide, 500);
      return () => clearTimeout(t);
    }

    const onLoad = () => setTimeout(hide, 300);
    window.addEventListener("load", onLoad, { once: true });
    const failsafe = setTimeout(hide, 5000);
    return () => {
      window.removeEventListener("load", onLoad);
      clearTimeout(failsafe);
    };
  }, []);

  return <LoadingVeil open={visible} caption="Loading your dashboard" z={100} />;
}
