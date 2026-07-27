import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
  type ThemedTokenWithVariants,
} from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import githubDark from "@shikijs/themes/github-dark-default";
import githubLight from "@shikijs/themes/github-light-default";

import type { SyntaxLanguage, SyntaxToken } from "./syntax-types";

const ITALIC = 1;
const BOLD = 2;

type LanguageModule = {
  default: readonly LanguageRegistration[];
};

const languages: Readonly<
  Record<SyntaxLanguage, () => Promise<LanguageModule>>
> = {
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  dart: () => import("@shikijs/langs/dart"),
  docker: () => import("@shikijs/langs/docker"),
  go: () => import("@shikijs/langs/go"),
  graphql: () => import("@shikijs/langs/graphql"),
  hcl: () => import("@shikijs/langs/hcl"),
  html: () => import("@shikijs/langs/html"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  jsx: () => import("@shikijs/langs/jsx"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  lua: () => import("@shikijs/langs/lua"),
  markdown: () => import("@shikijs/langs/markdown"),
  php: () => import("@shikijs/langs/php"),
  powershell: () => import("@shikijs/langs/powershell"),
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  scss: () => import("@shikijs/langs/scss"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  swift: () => import("@shikijs/langs/swift"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loaded = new Set<SyntaxLanguage>();
const loading = new Map<SyntaxLanguage, Promise<void>>();

const getHighlighter = (): Promise<HighlighterCore> => {
  if (highlighterPromise !== null) return highlighterPromise;

  const promise = createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    langs: [],
    themes: [githubLight, githubDark],
  }).catch((error: unknown) => {
    if (highlighterPromise === promise) highlighterPromise = null;
    throw error;
  });
  highlighterPromise = promise;
  return promise;
};

const loadLanguage = async (
  language: SyntaxLanguage,
): Promise<HighlighterCore> => {
  const highlighter = await getHighlighter();
  if (loaded.has(language)) return highlighter;

  let promise = loading.get(language);
  if (promise === undefined) {
    promise = languages[language]()
      .then(({ default: registrations }) =>
        highlighter.loadLanguage(...registrations),
      )
      .then(() => {
        loaded.add(language);
      });
    loading.set(language, promise);
    void promise
      .catch(() => undefined)
      .finally(() => {
        if (loading.get(language) === promise) loading.delete(language);
      });
  }

  await promise;
  return highlighter;
};

const token = (value: ThemedTokenWithVariants): SyntaxToken => {
  const light = value.variants.light;
  const dark = value.variants.dark;
  const darkStyles = Math.max(0, dark?.fontStyle ?? 0);
  const lightStyles = Math.max(0, light?.fontStyle ?? 0);

  return {
    content: value.content,
    darkFontStyle: (darkStyles & ITALIC) === 0 ? "normal" : "italic",
    darkFontWeight: (darkStyles & BOLD) === 0 ? 400 : 700,
    darkForeground: dark?.color ?? "inherit",
    lightFontStyle: (lightStyles & ITALIC) === 0 ? "normal" : "italic",
    lightFontWeight: (lightStyles & BOLD) === 0 ? 400 : 700,
    lightForeground: light?.color ?? "inherit",
  };
};

export const highlightSyntax = async (
  source: string,
  language: SyntaxLanguage,
): Promise<readonly (readonly SyntaxToken[])[]> => {
  const highlighter = await loadLanguage(language);
  return highlighter
    .codeToTokensWithThemes(source, {
      lang: language,
      themes: {
        dark: "github-dark-default",
        light: "github-light-default",
      },
    })
    .map((line) => line.map(token));
};
