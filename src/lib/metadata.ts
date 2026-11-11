/**
 * DRAFT business metadata contracts.
 *
 * These types deliberately contain no content body. RAGFlow is the only source
 * of truth for content (ADR-005); this module does not call any external API.
 */

export const workStages = ["draft", "finished", "published", "practiced"] as const;

export type WorkStage = (typeof workStages)[number];
export type Library = "internal" | "external";
export type Priority = "low" | "medium" | "high";

/** Application-owned mapping fields, not a claim about RAGFlow's API schema. */
export interface ContentRef {
  provider: "ragflow";
  datasetId: string;
  documentId: string;
}

interface BusinessMetadata {
  id: string;
  title: string;
  library: Library;
  categories: string[];
  tags: string[];
  priority: Priority;
  /**
   * Null is reserved for an unsynchronised design/draft state. Never populate
   * this field with a fabricated identifier; real values arrive in Phase 2.
   */
  contentRef: ContentRef | null;
  createdAt: string;
  updatedAt: string;
}

export interface Asset extends BusinessMetadata {
  type: "asset";
}

export interface Work extends BusinessMetadata {
  type: "work";
  status: WorkStage;
}
