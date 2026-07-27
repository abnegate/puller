import { highlightSyntax } from "./syntax-engine";
import { highlightHunks } from "./syntax-highlight";
import type {
  SyntaxHighlightResponse,
  SyntaxWorkerRequest,
} from "./syntax-protocol";
import { createSyntaxWorkerRuntime } from "./syntax-worker-runtime";

type WorkerScope = {
  onmessage: ((event: MessageEvent<SyntaxWorkerRequest>) => void) | null;
  postMessage: (response: SyntaxHighlightResponse) => void;
};

const scope = globalThis as unknown as WorkerScope;
const runtime = createSyntaxWorkerRuntime(
  ({ hunks, language }, cancelled) =>
    highlightHunks(hunks, language, highlightSyntax, cancelled),
  (response) => scope.postMessage(response),
);

scope.onmessage = ({ data }) => runtime.receive(data);
