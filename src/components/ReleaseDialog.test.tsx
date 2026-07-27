// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getReleaseOptionsStorageKey,
  resetReleaseOptionsCacheForTests,
} from "@/release-options";
import type { ReleaseOptions, ReleasePreview } from "@/types";

import ReleaseDialog from "./ReleaseDialog";

const api = vi.hoisted(() => ({
  create: vi.fn(),
  options: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("@/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api")>()),
  createRelease: api.create,
  getReleasePreview: api.preview,
  getReleaseOptions: api.options,
}));

const releaseOptions = (
  overrides: Partial<ReleaseOptions> = {},
): ReleaseOptions => ({
  generatedAt: "2026-07-21T08:02:00.000Z",
  repositories: [
    {
      latestTag: "v1.2.3",
      nextTag: "v1.2.4",
      previousTags: ["v1.2.3", "v1.2.2"],
      repository: "appwrite/cloud",
      repositoryUrl: "https://github.com/appwrite/cloud",
    },
  ],
  repositoriesUpdatedAt: "2026-07-21T08:00:00.000Z",
  tagsUpdatedAt: "2026-07-21T08:01:00.000Z",
  viewerLogin: "jake",
  warnings: [],
  ...overrides,
});

const releasePreview = (
  overrides: Partial<ReleasePreview> = {},
): ReleasePreview => ({
  baseTag: "v1.2.3",
  body: "* Fix release behavior by @jake in https://github.com/appwrite/cloud/pull/927",
  digest: "a".repeat(64),
  name: "Generated v1.2.4",
  pulls: [
    {
      number: 927,
      title: "Fix release behavior",
      url: "https://github.com/appwrite/cloud/pull/927",
    },
  ],
  repository: "appwrite/cloud",
  tag: "v1.2.4",
  targetOid: "cccccccccccccccccccccccccccccccccccccccc",
  ...overrides,
});

const originalLocalStorage = Object.getOwnPropertyDescriptor(
  window,
  "localStorage",
);

beforeEach(() => {
  resetReleaseOptionsCacheForTests();
  api.preview.mockImplementation(
    async (request: {
      expectedLatestTag: string | null;
      repository: string;
      tag: string;
    }) =>
      releasePreview({
        baseTag: request.expectedLatestTag,
        pulls: [
          {
            number: 927,
            title: "Fix release behavior",
            url: `https://github.com/${request.repository}/pull/927`,
          },
        ],
        repository: request.repository,
        tag: request.tag,
      }),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
  );
  const values = new Map<string, string>();
  const storage: Storage = {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
});

afterEach(() => {
  cleanup();
  resetReleaseOptionsCacheForTests();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  if (originalLocalStorage) {
    Object.defineProperty(window, "localStorage", originalLocalStorage);
  }
});

describe("ReleaseDialog", () => {
  it("does not load options until the generated-notes dialog first opens", async () => {
    api.options.mockReturnValue(new Promise(() => undefined));
    render(<ReleaseDialog onCreated={vi.fn()} viewerLogin="jake" />);

    const trigger = screen.getByRole("button", { name: "Release" });
    expect(trigger).toHaveClass("min-h-11", "sm:min-h-7");
    await Promise.resolve();
    expect(api.options).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    await waitFor(() =>
      expect(api.options).toHaveBeenCalledWith(false, expect.any(AbortSignal)),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", {
      name: "Create a release",
    });
    expect(dialog).toHaveTextContent("GitHub-generated release notes");
    expect(screen.getByLabelText("Release repository")).toBeDisabled();
    expect(screen.getByLabelText("Release tag")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Review release" }),
    ).toBeDisabled();
    expect(api.options).toHaveBeenCalledTimes(1);
  });

  it("keeps cached controls usable when a background refresh fails and retries explicitly", async () => {
    const cached = releaseOptions();
    const refreshed = releaseOptions({
      repositories: [
        {
          latestTag: "v1.2.4",
          nextTag: "v1.2.5",
          previousTags: ["v1.2.4", "v1.2.3"],
          repository: "appwrite/cloud",
          repositoryUrl: "https://github.com/appwrite/cloud",
        },
      ],
      tagsUpdatedAt: "2026-07-21T09:01:00.000Z",
    });
    window.localStorage.setItem(
      getReleaseOptionsStorageKey("jake"),
      JSON.stringify({
        options: cached,
        storedAt: "2026-07-21T08:03:00.000Z",
        version: 1,
        viewerLogin: "jake",
      }),
    );
    api.options
      .mockRejectedValueOnce(new Error("GitHub is unavailable."))
      .mockResolvedValueOnce(refreshed);

    render(<ReleaseDialog onCreated={vi.fn()} viewerLogin="jake" />);
    await Promise.resolve();
    expect(api.options).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Release" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "GitHub is unavailable.",
    );
    expect(screen.getByLabelText("Release repository")).toBeEnabled();
    expect(screen.getByLabelText("Release repository")).toHaveTextContent(
      "appwrite/cloud",
    );
    expect(screen.getByLabelText("Release tag")).toBeEnabled();
    expect(screen.getByLabelText("Release tag")).toHaveValue("v1.2.4");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(api.options).toHaveBeenNthCalledWith(
        2,
        true,
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Release tag")).toHaveValue("v1.2.5"),
    );
  });

  it("clears the previous viewer selection while authentication is absent or changes", async () => {
    let resolveBob: (options: ReleaseOptions) => void = () => undefined;
    const bob = new Promise<ReleaseOptions>((resolve) => {
      resolveBob = resolve;
    });
    api.options
      .mockResolvedValueOnce(releaseOptions())
      .mockReturnValueOnce(bob);
    const onCreated = vi.fn();
    const view = render(
      <ReleaseDialog onCreated={onCreated} viewerLogin="jake" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Release repository")).toHaveTextContent(
        "appwrite/cloud",
      ),
    );

    view.rerender(<ReleaseDialog onCreated={onCreated} viewerLogin={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(screen.getByLabelText("Release repository")).toBeDisabled();
    expect(screen.getByLabelText("Release repository")).not.toHaveTextContent(
      "appwrite/cloud",
    );
    expect(api.options).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    view.rerender(<ReleaseDialog onCreated={onCreated} viewerLogin="bob" />);
    expect(api.options).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() => expect(api.options).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Release repository")).toBeDisabled();
    expect(screen.getByLabelText("Release repository")).not.toHaveTextContent(
      "appwrite/cloud",
    );

    resolveBob(
      releaseOptions({
        repositories: [
          {
            latestTag: "v2.0.0",
            nextTag: "v2.0.1",
            previousTags: ["v2.0.0"],
            repository: "appwrite/edge",
            repositoryUrl: "https://github.com/appwrite/edge",
          },
        ],
        viewerLogin: "bob",
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Release repository")).toHaveTextContent(
        "appwrite/edge",
      ),
    );
  });

  it("refreshes tags on every later open without clearing cached options or selection", async () => {
    let resolveRefresh: (options: ReleaseOptions) => void = () => undefined;
    const refresh = new Promise<ReleaseOptions>((resolve) => {
      resolveRefresh = resolve;
    });
    const initial = releaseOptions({
      repositories: [
        {
          latestTag: "v2.0.0",
          nextTag: "v2.0.1",
          previousTags: ["v2.0.0", "v1.9.9"],
          repository: "appwrite/edge",
          repositoryUrl: "https://github.com/appwrite/edge",
        },
        {
          latestTag: "v1.2.3",
          nextTag: "v1.2.4",
          previousTags: ["v1.2.3", "v1.2.2"],
          repository: "appwrite/cloud",
          repositoryUrl: "https://github.com/appwrite/cloud",
        },
      ],
    });
    const refreshed = releaseOptions({
      generatedAt: "2026-07-21T09:02:00.000Z",
      repositories: [
        {
          latestTag: "v1.2.3",
          nextTag: "v1.2.4",
          previousTags: ["v1.2.3", "v1.2.2"],
          repository: "appwrite/cloud",
          repositoryUrl: "https://github.com/appwrite/cloud",
        },
        {
          latestTag: "v2.0.1",
          nextTag: "v2.0.2",
          previousTags: ["v2.0.1", "v2.0.0"],
          repository: "appwrite/edge",
          repositoryUrl: "https://github.com/appwrite/edge",
        },
      ],
      repositoriesUpdatedAt: initial.repositoriesUpdatedAt,
      tagsUpdatedAt: "2026-07-21T09:01:00.000Z",
    });
    api.options.mockResolvedValueOnce(initial).mockReturnValueOnce(refresh);
    render(<ReleaseDialog onCreated={vi.fn()} viewerLogin="jake" />);

    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Release repository")).toHaveTextContent(
        "appwrite/edge",
      ),
    );
    expect(screen.getByLabelText("Release tag")).toHaveValue("v2.0.1");

    let times = document.querySelectorAll("time");
    expect(times).toHaveLength(2);
    expect(times[0]).toHaveAttribute("dateTime", initial.repositoriesUpdatedAt);
    expect(times[0]).toHaveAttribute("title");
    expect(times[0]?.textContent).toMatch(/(?:ago|just now|^in )/);
    expect(times[1]).toHaveAttribute("dateTime", initial.tagsUpdatedAt);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Release" }));

    await waitFor(() =>
      expect(api.options).toHaveBeenNthCalledWith(
        2,
        true,
        expect.any(AbortSignal),
      ),
    );
    expect(screen.getByLabelText("Release repository")).toHaveTextContent(
      "appwrite/edge",
    );
    expect(screen.getByLabelText("Release repository")).toBeEnabled();
    expect(screen.getByLabelText("Release tag")).toHaveValue("v2.0.1");
    expect(screen.getByLabelText("Release tag")).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() => expect(api.options).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Release repository")).toHaveTextContent(
      "appwrite/edge",
    );
    expect(screen.getByLabelText("Release tag")).toHaveValue("v2.0.1");

    fireEvent.click(
      screen.getByRole("button", { name: "Show release tag options" }),
    );
    expect(
      screen.getByRole("option", { name: "v2.0.0, Existing" }),
    ).toBeVisible();

    resolveRefresh(refreshed);

    await waitFor(() =>
      expect(screen.getByLabelText("Release tag")).toHaveValue("v2.0.2"),
    );
    expect(screen.getByLabelText("Release repository")).toHaveTextContent(
      "appwrite/edge",
    );
    expect(screen.getByText("Latest: v2.0.1")).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "v2.0.1, Existing" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "v1.9.9, Existing" }),
    ).not.toBeInTheDocument();
    times = document.querySelectorAll("time");
    expect(times[0]).toHaveAttribute(
      "dateTime",
      refreshed.repositoriesUpdatedAt,
    );
    expect(times[1]).toHaveAttribute("dateTime", refreshed.tagsUpdatedAt);
  });

  it("searches repositories and applies the selected tag recommendation", async () => {
    api.options.mockResolvedValue(
      releaseOptions({
        repositories: [
          {
            latestTag: "v1.2.3",
            nextTag: "v1.2.4",
            previousTags: ["v1.2.3", "v1.2.2"],
            repository: "appwrite/cloud",
            repositoryUrl: "https://github.com/appwrite/cloud",
          },
          {
            latestTag: "v2.0.0",
            nextTag: "v2.0.1",
            previousTags: ["v2.0.0", "v1.9.9"],
            repository: "Appwrite-Labs/Edge",
            repositoryUrl: "https://github.com/appwrite-labs/edge",
          },
        ],
      }),
    );
    render(<ReleaseDialog onCreated={vi.fn()} viewerLogin="jake" />);

    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Release tag")).toHaveValue("v1.2.4"),
    );

    fireEvent.click(screen.getByLabelText("Release repository"));
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Search repositories" }),
      { target: { value: "labs/edge" } },
    );
    fireEvent.click(screen.getByRole("option", { name: "Appwrite-Labs/Edge" }));

    expect(screen.getByLabelText("Release repository")).toHaveTextContent(
      "Appwrite-Labs/Edge",
    );
    expect(screen.getByLabelText("Release tag")).toHaveValue("v2.0.1");
    fireEvent.click(
      screen.getByRole("button", { name: "Show release tag options" }),
    );
    expect(
      screen.getByRole("option", { name: "v2.0.0, Existing" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "v1.2.3, Existing" }),
    ).not.toBeInTheDocument();
  });

  it("rejects an exact backend-provided existing tag and allows an unlisted custom tag", async () => {
    api.options.mockResolvedValue(releaseOptions());
    render(<ReleaseDialog onCreated={vi.fn()} viewerLogin="jake" />);

    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    const tag = await screen.findByLabelText("Release tag");
    await waitFor(() => expect(tag).toHaveValue("v1.2.4"));

    fireEvent.change(tag, { target: { value: "v1.2.2" } });

    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent("That tag already exists.");
    expect(tag).toHaveAttribute("aria-invalid", "true");
    expect(tag.getAttribute("aria-describedby")?.split(" ")).toContain(
      error.id,
    );
    expect(
      screen.getByRole("button", { name: "Review release" }),
    ).toBeDisabled();

    fireEvent.change(tag, { target: { value: "v1.2.1" } });

    expect(
      screen.queryByText("That tag already exists."),
    ).not.toBeInTheDocument();
    expect(tag).not.toHaveAttribute("aria-invalid");
    expect(
      screen.getByRole("button", { name: "Review release" }),
    ).toBeEnabled();
  });

  it("defaults to a described production release and submits the unchecked option", async () => {
    let resolveCreate: (release: {
      id: string;
      name: string;
      publishedAt: string;
      repository: string;
      tag: string;
      url: string;
    }) => void = () => undefined;
    const created = new Promise<{
      id: string;
      name: string;
      publishedAt: string;
      repository: string;
      tag: string;
      url: string;
    }>((resolve) => {
      resolveCreate = resolve;
    });
    api.options.mockResolvedValue(releaseOptions());
    api.create.mockReturnValue(created);
    render(<ReleaseDialog onCreated={vi.fn()} viewerLogin="jake" />);

    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Release tag")).toHaveValue("v1.2.4"),
    );

    const prerelease = screen.getByRole("checkbox", { name: "Pre-release" });
    const description = screen.getByText(
      "Mark this release as not ready for production.",
    );
    expect(
      prerelease.closest("[data-slot='release-prerelease-option']"),
    ).toHaveClass("items-center");
    expect(prerelease).not.toBeChecked();
    expect(prerelease).toHaveAttribute("aria-describedby", description.id);

    fireEvent.click(screen.getByText("Pre-release"));
    expect(prerelease).toBeChecked();
    fireEvent.click(screen.getByText("Pre-release"));
    expect(prerelease).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Review release" }));
    expect(
      screen.getByRole("heading", { name: "Publish v1.2.4?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Publish release" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByRole("link", { name: /Fix release behavior/ }),
    ).toHaveAttribute("href", "https://github.com/appwrite/cloud/pull/927");
    expect(api.preview).toHaveBeenCalledWith(
      {
        expectedLatestTag: "v1.2.3",
        repository: "appwrite/cloud",
        tag: "v1.2.4",
      },
      expect.any(AbortSignal),
    );

    const publish = screen.getByRole("button", { name: "Publish release" });
    await waitFor(() => expect(publish).toBeEnabled());
    fireEvent.click(publish);

    expect(api.create).toHaveBeenCalledWith(
      {
        expectedLatestTag: "v1.2.3",
        prerelease: false,
        preview: releasePreview(),
        repository: "appwrite/cloud",
        tag: "v1.2.4",
      },
      expect.any(AbortSignal),
    );
    await waitFor(() => expect(prerelease).toBeDisabled());

    resolveCreate({
      id: "release-1",
      name: "v1.2.4",
      publishedAt: "2026-07-21T08:03:00.000Z",
      repository: "appwrite/cloud",
      tag: "v1.2.4",
      url: "https://github.com/appwrite/cloud/releases/tag/v1.2.4",
    });
    await screen.findByText("v1.2.4 is published.");
  });

  it("shows every included pull request and permits an empty generated-notes range", async () => {
    api.options.mockResolvedValue(releaseOptions());
    api.preview
      .mockResolvedValueOnce(
        releasePreview({
          pulls: [
            {
              number: 927,
              title: "Fix release behavior",
              url: "https://github.com/appwrite/cloud/pull/927",
            },
            {
              number: 931,
              title: "Harden the deployment",
              url: "https://github.com/appwrite/cloud/pull/931",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(releasePreview({ pulls: [] }));
    render(<ReleaseDialog onCreated={vi.fn()} viewerLogin="jake" />);

    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Release tag")).toHaveValue("v1.2.4"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review release" }));

    expect(
      await screen.findByRole("link", { name: /Fix release behavior/ }),
    ).toHaveAttribute("href", "https://github.com/appwrite/cloud/pull/927");
    expect(
      screen.getByRole("link", { name: /Harden the deployment/ }),
    ).toHaveAttribute("href", "https://github.com/appwrite/cloud/pull/931");
    expect(
      screen.getByRole("region", { name: "Included pull requests" }),
    ).toHaveTextContent("2");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Review release" }));

    expect(
      await screen.findByText(
        "No pull requests are included in these generated notes.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Publish release" }),
    ).toBeEnabled();
  });

  it("keeps publishing disabled until a failed preview is retried", async () => {
    api.options.mockResolvedValue(releaseOptions());
    api.preview
      .mockRejectedValueOnce(new Error("GitHub could not generate notes."))
      .mockResolvedValueOnce(releasePreview());
    render(<ReleaseDialog onCreated={vi.fn()} viewerLogin="jake" />);

    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Release tag")).toHaveValue("v1.2.4"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review release" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "GitHub could not generate notes.",
    );
    const publish = screen.getByRole("button", { name: "Publish release" });
    expect(publish).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("link", { name: /Fix release behavior/ }),
    ).toBeInTheDocument();
    expect(publish).toBeEnabled();
  });

  it("preserves a pre-release through confirmation cancellation and conflict retry", async () => {
    const initial = releaseOptions();
    const refreshed = releaseOptions({
      repositories: [
        {
          latestTag: "v1.2.4",
          nextTag: "v1.2.5",
          previousTags: ["v1.2.4", "v1.2.3"],
          repository: "appwrite/cloud",
          repositoryUrl: "https://github.com/appwrite/cloud",
        },
      ],
      tagsUpdatedAt: "2026-07-21T08:03:00.000Z",
    });
    api.options.mockResolvedValueOnce(initial).mockResolvedValue(refreshed);
    api.create
      .mockRejectedValueOnce(
        new Error("The latest repository tag changed. Reload options."),
      )
      .mockResolvedValue({
        id: "release-2",
        name: "v1.2.5",
        publishedAt: "2026-07-21T08:04:00.000Z",
        repository: "appwrite/cloud",
        tag: "v1.2.5",
        url: "https://github.com/appwrite/cloud/releases/tag/v1.2.5",
      });
    render(<ReleaseDialog onCreated={vi.fn()} viewerLogin="jake" />);

    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Release tag")).toHaveValue("v1.2.4"),
    );
    const prerelease = screen.getByRole("checkbox", { name: "Pre-release" });
    fireEvent.click(screen.getByText("Pre-release"));
    expect(prerelease).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Review release" }));
    expect(
      screen.getByRole("heading", {
        name: "Publish v1.2.4 as a pre-release?",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      /This publishes v1\.2\.4 as a pre-release in appwrite\/cloud/,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(prerelease).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Review release" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Publish pre-release" }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Publish pre-release" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The latest repository tag changed. Reload options.",
    );
    expect(api.create).toHaveBeenNthCalledWith(
      1,
      {
        expectedLatestTag: "v1.2.3",
        prerelease: true,
        preview: releasePreview(),
        repository: "appwrite/cloud",
        tag: "v1.2.4",
      },
      expect.any(AbortSignal),
    );

    fireEvent.click(screen.getByRole("button", { name: "Reload options" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Release tag")).toHaveValue("v1.2.5"),
    );
    expect(prerelease).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Review again" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Publish pre-release" }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Publish pre-release" }),
    );

    expect(api.create).toHaveBeenNthCalledWith(
      2,
      {
        expectedLatestTag: "v1.2.4",
        prerelease: true,
        preview: releasePreview({
          baseTag: "v1.2.4",
          tag: "v1.2.5",
        }),
        repository: "appwrite/cloud",
        tag: "v1.2.5",
      },
      expect.any(AbortSignal),
    );
    await screen.findByText("v1.2.5 is published as a pre-release.");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: "Pre-release" }),
      ).not.toBeChecked(),
    );
  });

  it("keeps the release dialog open when Escape closes the tag options", async () => {
    api.options.mockResolvedValue(releaseOptions());
    render(<ReleaseDialog onCreated={vi.fn()} viewerLogin="jake" />);

    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    const tag = await screen.findByLabelText("Release tag");
    await waitFor(() => expect(tag).toHaveValue("v1.2.4"));
    fireEvent.click(
      screen.getByRole("button", { name: "Show release tag options" }),
    );
    const history = screen.getByRole("option", {
      name: "v1.2.3, Existing",
    });
    history.focus();

    fireEvent.keyDown(history, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("dialog", { name: "Create a release" }),
    ).toBeVisible();
    expect(tag).toHaveFocus();
  });

  it("preserves a custom edit made while refreshed tag history is loading", async () => {
    let resolveRefresh: (options: ReleaseOptions) => void = () => undefined;
    const refresh = new Promise<ReleaseOptions>((resolve) => {
      resolveRefresh = resolve;
    });
    const refreshed = releaseOptions({
      repositories: [
        {
          latestTag: "v1.2.4",
          nextTag: "v1.2.5",
          previousTags: ["v1.2.4", "v1.2.3"],
          repository: "appwrite/cloud",
          repositoryUrl: "https://github.com/appwrite/cloud",
        },
      ],
      tagsUpdatedAt: "2026-07-21T09:01:00.000Z",
    });
    api.options
      .mockResolvedValueOnce(releaseOptions())
      .mockReturnValueOnce(refresh);
    render(<ReleaseDialog onCreated={vi.fn()} viewerLogin="jake" />);

    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Release tag")).toHaveValue("v1.2.4"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() => expect(api.options).toHaveBeenCalledTimes(2));

    const tag = screen.getByLabelText("Release tag");
    fireEvent.change(tag, { target: { value: "v2.0.0-rc.1" } });
    resolveRefresh(refreshed);

    await waitFor(() =>
      expect(screen.getByText("Latest: v1.2.4")).toBeInTheDocument(),
    );
    expect(tag).toHaveValue("v2.0.0-rc.1");
  });

  it("preserves a custom tag typed after a cached initial prefetch starts", async () => {
    let resolvePrefetch: (options: ReleaseOptions) => void = () => undefined;
    const prefetch = new Promise<ReleaseOptions>((resolve) => {
      resolvePrefetch = resolve;
    });
    const cached = releaseOptions();
    const refreshed = releaseOptions({
      generatedAt: "2026-07-21T09:02:00.000Z",
      repositories: [
        {
          latestTag: "v1.2.4",
          nextTag: "v1.2.5",
          previousTags: ["v1.2.4", "v1.2.3"],
          repository: "appwrite/cloud",
          repositoryUrl: "https://github.com/appwrite/cloud",
        },
      ],
      tagsUpdatedAt: "2026-07-21T09:01:00.000Z",
    });
    window.localStorage.setItem(
      getReleaseOptionsStorageKey("jake"),
      JSON.stringify({
        options: cached,
        storedAt: "2026-07-21T08:03:00.000Z",
        version: 1,
        viewerLogin: "jake",
      }),
    );
    api.options.mockReturnValue(prefetch);
    render(<ReleaseDialog onCreated={vi.fn()} viewerLogin="jake" />);
    await Promise.resolve();
    expect(api.options).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() => expect(api.options).toHaveBeenCalledTimes(1));
    const tag = screen.getByLabelText("Release tag");
    expect(tag).toHaveValue("v1.2.4");
    fireEvent.change(tag, { target: { value: "v3.0.0-custom" } });

    resolvePrefetch(refreshed);

    await waitFor(() =>
      expect(screen.getByText("Latest: v1.2.4")).toBeInTheDocument(),
    );
    expect(tag).toHaveValue("v3.0.0-custom");
    expect(document.querySelectorAll("time")[1]).toHaveAttribute(
      "dateTime",
      refreshed.tagsUpdatedAt,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Show release tag options" }),
    );
    expect(
      screen.getByRole("option", { name: "v1.2.4, Existing" }),
    ).toBeVisible();
  });

  it("preserves a custom tag typed after a forced refresh starts", async () => {
    let resolveRefresh: (options: ReleaseOptions) => void = () => undefined;
    const refresh = new Promise<ReleaseOptions>((resolve) => {
      resolveRefresh = resolve;
    });
    const cached = releaseOptions();
    const refreshed = releaseOptions({
      generatedAt: "2026-07-21T09:02:00.000Z",
      repositories: [
        {
          latestTag: "v1.2.4",
          nextTag: "v1.2.5",
          previousTags: ["v1.2.4", "v1.2.3"],
          repository: "appwrite/cloud",
          repositoryUrl: "https://github.com/appwrite/cloud",
        },
      ],
      tagsUpdatedAt: "2026-07-21T09:01:00.000Z",
    });
    window.localStorage.setItem(
      getReleaseOptionsStorageKey("jake"),
      JSON.stringify({
        options: cached,
        storedAt: "2026-07-21T08:03:00.000Z",
        version: 1,
        viewerLogin: "jake",
      }),
    );
    api.options
      .mockRejectedValueOnce(new Error("GitHub is unavailable."))
      .mockReturnValueOnce(refresh);
    render(<ReleaseDialog onCreated={vi.fn()} viewerLogin="jake" />);
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "GitHub is unavailable.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(api.options).toHaveBeenNthCalledWith(
        2,
        true,
        expect.any(AbortSignal),
      ),
    );
    const tag = screen.getByLabelText("Release tag");
    fireEvent.change(tag, { target: { value: "v3.0.0-custom" } });

    resolveRefresh(refreshed);

    await waitFor(() =>
      expect(screen.getByText("Latest: v1.2.4")).toBeInTheDocument(),
    );
    expect(tag).toHaveValue("v3.0.0-custom");
    expect(document.querySelectorAll("time")[1]).toHaveAttribute(
      "dateTime",
      refreshed.tagsUpdatedAt,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Show release tag options" }),
    );
    expect(
      screen.getByRole("option", { name: "v1.2.4, Existing" }),
    ).toBeVisible();
  });

  it("hides non-actionable history warnings while retaining actionable release warnings", async () => {
    api.options.mockResolvedValue(
      releaseOptions({
        warnings: [
          "GitHub truncated the authored merged pull request search.",
          "History may be incomplete.",
          "Some authored merged pull requests could not be loaded for release membership.",
          "The selected repository tag cannot be reached from its default branch.",
        ],
      }),
    );
    render(<ReleaseDialog onCreated={vi.fn()} viewerLogin="jake" />);

    fireEvent.click(screen.getByRole("button", { name: "Release" }));

    expect(
      await screen.findByText(
        "The selected repository tag cannot be reached from its default branch.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "GitHub truncated the authored merged pull request search.",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("History may be incomplete."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Some authored merged pull requests could not be loaded for release membership.",
      ),
    ).not.toBeInTheDocument();
  });

  it("refreshes tags on a later open even when the first option load failed", async () => {
    api.options
      .mockRejectedValueOnce(new Error("GitHub authentication failed."))
      .mockResolvedValueOnce(releaseOptions());
    render(<ReleaseDialog onCreated={vi.fn()} viewerLogin="jake" />);

    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "GitHub authentication failed.",
    );
    expect(api.options).toHaveBeenNthCalledWith(
      1,
      false,
      expect.any(AbortSignal),
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Release" }));

    await waitFor(() =>
      expect(api.options).toHaveBeenNthCalledWith(
        2,
        true,
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Release repository")).toHaveTextContent(
        "appwrite/cloud",
      ),
    );
  });

  it("keeps custom tags editable and refreshes only tag recommendations after a conflict", async () => {
    api.options.mockResolvedValueOnce(releaseOptions()).mockResolvedValueOnce(
      releaseOptions({
        generatedAt: "2026-07-21T08:04:00.000Z",
        repositories: [
          {
            latestTag: "v1.2.4",
            nextTag: "v1.2.5",
            previousTags: ["v1.2.4", "v1.2.3"],
            repository: "appwrite/cloud",
            repositoryUrl: "https://github.com/appwrite/cloud",
          },
        ],
        tagsUpdatedAt: "2026-07-21T08:03:00.000Z",
      }),
    );
    api.create.mockRejectedValue(
      new Error("The latest repository tag changed. Reload options."),
    );
    render(<ReleaseDialog onCreated={vi.fn()} viewerLogin="jake" />);

    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    const tag = await screen.findByLabelText("Release tag");
    await waitFor(() =>
      expect(api.options).toHaveBeenCalledWith(false, expect.any(AbortSignal)),
    );
    expect(api.options).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByLabelText("Release repository")).toHaveTextContent(
        "appwrite/cloud",
      ),
    );
    await waitFor(() => expect(tag).toHaveValue("v1.2.4"));
    expect(tag).toBeEnabled();

    fireEvent.change(tag, { target: { value: "v2.0.0-rc.1" } });
    expect(tag).toHaveValue("v2.0.0-rc.1");
    fireEvent.click(screen.getByRole("button", { name: "Review release" }));
    const publish = screen.getByRole("button", { name: "Publish release" });
    await waitFor(() => expect(publish).toBeEnabled());
    fireEvent.click(publish);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The latest repository tag changed. Reload options.",
    );
    expect(api.create).toHaveBeenCalledWith(
      {
        expectedLatestTag: "v1.2.3",
        prerelease: false,
        preview: releasePreview({ tag: "v2.0.0-rc.1" }),
        repository: "appwrite/cloud",
        tag: "v2.0.0-rc.1",
      },
      expect.any(AbortSignal),
    );

    fireEvent.click(screen.getByRole("button", { name: "Reload options" }));

    await waitFor(() =>
      expect(api.options).toHaveBeenLastCalledWith(
        true,
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() => expect(tag).toHaveValue("v1.2.5"));
    expect(screen.getByText("Latest: v1.2.4")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The latest repository tag changed. Reload options.",
    );
  });

  it("refreshes tags after a release is published", async () => {
    const initial = releaseOptions();
    const refreshed = releaseOptions({
      generatedAt: "2026-07-21T08:04:00.000Z",
      repositories: [
        {
          latestTag: "v1.2.4",
          nextTag: "v1.2.5",
          previousTags: ["v1.2.4", "v1.2.3"],
          repository: "appwrite/cloud",
          repositoryUrl: "https://github.com/appwrite/cloud",
        },
      ],
      tagsUpdatedAt: "2026-07-21T08:03:00.000Z",
    });
    api.options.mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshed);
    api.create.mockResolvedValue({
      id: "release-1",
      name: "v1.2.4",
      publishedAt: "2026-07-21T08:03:00.000Z",
      repository: "appwrite/cloud",
      tag: "v1.2.4",
      url: "https://github.com/appwrite/cloud/releases/tag/v1.2.4",
    });
    const onCreated = vi.fn();
    render(<ReleaseDialog onCreated={onCreated} viewerLogin="jake" />);

    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Release tag")).toHaveValue("v1.2.4"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review release" }));
    const publish = screen.getByRole("button", { name: "Publish release" });
    await waitFor(() => expect(publish).toBeEnabled());
    fireEvent.click(publish);

    await screen.findByText("v1.2.4 is published.");
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: "release-1" }),
    );
    await waitFor(() =>
      expect(api.options).toHaveBeenLastCalledWith(
        true,
        expect.any(AbortSignal),
      ),
    );
  });
});
