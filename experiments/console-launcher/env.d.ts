/**
 * esbuild bundles the `*.css` import in `main.ts` into `main.css`; TypeScript
 * only needs to know the side-effect import is intentional. This file is part
 * of the evidence harness, not the product.
 */
declare module "*.css";
