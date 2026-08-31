// Runtime stub for the `server-only` marker package (Next provides its own build
// alias; it is a compile-time guard with zero runtime behavior). Lets standalone
// tsx harnesses import server-only modules (e.g. src/lib/tokens/promotion.ts).
export {};
