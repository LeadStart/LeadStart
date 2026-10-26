"use client";

import { useEffect } from "react";
import { quietPressRings } from "@/lib/ui/press-focus";

/** Mounted once in the root layout: Shift or Caps Lock alone never lights a focus ring. */
export function PressFocus() {
  useEffect(() => quietPressRings(), []);
  return null;
}
