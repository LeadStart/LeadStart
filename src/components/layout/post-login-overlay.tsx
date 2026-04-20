"use client";

import { useEffect, useState } from "react";
import { BounceLoader } from "@/components/ui/bounce-loader";

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

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: "#f8fafc" }}
    >
      <BounceLoader caption="Loading your dashboard" />
    </div>
  );
}
