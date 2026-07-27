import type { PullDiffHunk } from "./types";
import type { HighlightedFile, SyntaxLanguage } from "./syntax-types";

export type SyntaxHighlightRequest = {
  hunks: readonly PullDiffHunk[];
  id: number;
  kind: "highlight";
  language: SyntaxLanguage;
};

export type SyntaxCancelRequest = {
  id: number;
  kind: "cancel";
};

export type SyntaxWorkerRequest = SyntaxCancelRequest | SyntaxHighlightRequest;

export type SyntaxHighlightResponse =
  | {
      highlighted: HighlightedFile;
      id: number;
      kind: "highlighted";
    }
  | {
      error: string;
      id: number;
      kind: "error";
    };
