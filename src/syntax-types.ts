export type SyntaxLanguage =
  | "c"
  | "cpp"
  | "csharp"
  | "css"
  | "dart"
  | "docker"
  | "go"
  | "graphql"
  | "hcl"
  | "html"
  | "java"
  | "javascript"
  | "json"
  | "jsonc"
  | "jsx"
  | "kotlin"
  | "lua"
  | "markdown"
  | "php"
  | "powershell"
  | "python"
  | "ruby"
  | "rust"
  | "scss"
  | "shellscript"
  | "sql"
  | "swift"
  | "tsx"
  | "typescript"
  | "xml"
  | "yaml";

export type SyntaxToken = {
  content: string;
  darkFontStyle: "italic" | "normal";
  darkFontWeight: 400 | 700;
  darkForeground: string;
  lightFontStyle: "italic" | "normal";
  lightFontWeight: 400 | 700;
  lightForeground: string;
};

export type HighlightedDiffLine = readonly SyntaxToken[] | null;

export type HighlightedDiffHunk = {
  lines: readonly HighlightedDiffLine[];
};

export type HighlightedFile = {
  hunks: readonly HighlightedDiffHunk[];
  language: SyntaxLanguage;
};
