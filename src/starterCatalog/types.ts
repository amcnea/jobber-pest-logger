import type { ProductKind } from "../types";

/** Static Texas-common starter row (not shop-owned until copied). */
export interface StarterProduct {
  /** Stable id within the versioned starter list (not a shop catalog id). */
  id: string;
  name: string;
  /** Real EPA # when registered. Null for 25(b) and devices. */
  epaRegNo: string | null;
  is25b: boolean;
  kind: ProductKind;
}
