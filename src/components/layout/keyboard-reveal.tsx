"use client";

import { useEffect } from "react";
import { keyboardReveal } from "@/lib/ui/keyboard-reveal";

/** Mounted once in the root layout: on a phone, no text box on a page sits under the keyboard. */
export function KeyboardReveal() {
  useEffect(() => keyboardReveal(), []);
  return null;
}
