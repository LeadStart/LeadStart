import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Escape SQL LIKE/ILIKE wildcards so a value is matched literally. Without
// this, an email like "john_doe@x.com" used in .ilike() treats "_" as a
// single-char wildcard and matches unintended rows. Turns a case-insensitive
// pattern match into a case-insensitive exact match.
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
