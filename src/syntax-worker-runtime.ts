import type {
  SyntaxHighlightRequest,
  SyntaxHighlightResponse,
  SyntaxWorkerRequest,
} from "./syntax-protocol";
import type { HighlightedFile } from "./syntax-types";

type Highlight = (
  request: SyntaxHighlightRequest,
  cancelled: () => boolean,
) => Promise<HighlightedFile>;

export type SyntaxWorkerRuntime = {
  receive: (request: SyntaxWorkerRequest) => void;
};

export const createSyntaxWorkerRuntime = (
  highlight: Highlight,
  send: (response: SyntaxHighlightResponse) => void,
): SyntaxWorkerRuntime => {
  const cancelled = new Set<number>();
  const queue: SyntaxHighlightRequest[] = [];
  let running = false;

  const drain = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        const request = queue.shift()!;
        if (cancelled.delete(request.id)) continue;

        try {
          const highlighted = await highlight(request, () =>
            cancelled.has(request.id),
          );
          if (!cancelled.delete(request.id)) {
            send({ highlighted, id: request.id, kind: "highlighted" });
          }
        } catch (error) {
          if (!cancelled.delete(request.id)) {
            send({
              error: error instanceof Error ? error.message : String(error),
              id: request.id,
              kind: "error",
            });
          }
        }
      }
    } finally {
      running = false;
      if (queue.length > 0) void drain();
    }
  };

  return {
    receive: (request) => {
      if (request.kind === "cancel") {
        const index = queue.findIndex(({ id }) => id === request.id);
        if (index >= 0) queue.splice(index, 1);
        else cancelled.add(request.id);
        return;
      }

      queue.push(request);
      void drain();
    },
  };
};
