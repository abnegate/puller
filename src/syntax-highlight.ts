import type { PullDiffHunk } from "./types";
import type {
  HighlightedDiffHunk,
  HighlightedFile,
  SyntaxLanguage,
  SyntaxToken,
} from "./syntax-types";

type HighlightSyntax = (
  source: string,
  language: SyntaxLanguage,
) => Promise<readonly (readonly SyntaxToken[])[]>;

type HighlightStream = {
  contents: string[];
  diffLines: number[];
};

const streamFor = (
  hunk: PullDiffHunk,
  side: "new" | "old",
): HighlightStream => {
  const stream: HighlightStream = { contents: [], diffLines: [] };
  hunk.lines.forEach((line, diffLine) => {
    const belongs =
      line.kind === "context" ||
      (side === "new" && line.kind === "addition") ||
      (side === "old" && line.kind === "deletion");
    if (!belongs) return;
    stream.contents.push(line.content);
    stream.diffLines.push(diffLine);
  });
  return stream;
};

const tokenMap = (
  stream: HighlightStream,
  tokens: readonly (readonly SyntaxToken[])[],
): ReadonlyMap<number, readonly SyntaxToken[]> => {
  if (tokens.length !== stream.contents.length) return new Map();

  const mapped = new Map<number, readonly SyntaxToken[]>();
  tokens.forEach((line, index) => {
    const expected = stream.contents[index];
    if (
      expected !== undefined &&
      line.map((token) => token.content).join("") === expected
    ) {
      mapped.set(stream.diffLines[index]!, line);
    }
  });
  return mapped;
};

const highlightHunk = async (
  hunk: PullDiffHunk,
  language: SyntaxLanguage,
  highlightSyntax: HighlightSyntax,
  cancelled: () => boolean,
): Promise<HighlightedDiffHunk> => {
  const oldStream = streamFor(hunk, "old");
  const newStream = streamFor(hunk, "new");
  let oldTokens: readonly (readonly SyntaxToken[])[] = [];
  let newTokens: readonly (readonly SyntaxToken[])[] = [];

  if (oldStream.contents.length > 0 && !cancelled()) {
    oldTokens = await highlightSyntax(oldStream.contents.join("\n"), language);
  }
  if (newStream.contents.length > 0 && !cancelled()) {
    newTokens = await highlightSyntax(newStream.contents.join("\n"), language);
  }

  const oldMap = tokenMap(oldStream, oldTokens);
  const newMap = tokenMap(newStream, newTokens);
  return {
    lines: hunk.lines.map((line, index) => {
      if (line.kind === "deletion") return oldMap.get(index) ?? null;
      if (line.kind === "addition" || line.kind === "context") {
        return newMap.get(index) ?? null;
      }
      return null;
    }),
  };
};

export const highlightHunks = async (
  hunks: readonly PullDiffHunk[],
  language: SyntaxLanguage,
  highlightSyntax: HighlightSyntax,
  cancelled: () => boolean = () => false,
): Promise<HighlightedFile> => {
  const highlighted: HighlightedDiffHunk[] = [];
  for (const hunk of hunks) {
    if (cancelled()) break;
    highlighted.push(
      await highlightHunk(hunk, language, highlightSyntax, cancelled),
    );
  }
  return { hunks: highlighted, language };
};
