import type { ModelContextLike } from "@recovery/webmcp";

declare global {
  interface Document {
    modelContext?: ModelContextLike;
  }
}
export {};
