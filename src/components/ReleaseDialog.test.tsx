// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReleaseOptions } from "@/types";

import ReleaseDialog from "./ReleaseDialog";

const api = vi.hoisted(() => ({
  create: vi.fn(),
  options: vi.fn(),
}));

vi.mock("@/api", () => ({
  createRelease: api.create,
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

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("ReleaseDialog", () => {
  it("loads only after the compact trigger opens an accessible generated-notes dialog", async () => {
    api.options.mockReturnValue(new Promise(() => undefined));
    render(<ReleaseDialog onCreated={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "Release" });
    expect(trigger).toHaveClass("min-h-11", "sm:min-h-7");
    expect(api.options).not.toHaveBeenCalled();

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
    expect(api.options).toHaveBeenCalledWith(false, expect.any(AbortSignal));
    expect(api.options).toHaveBeenCalledTimes(1);
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
    render(<ReleaseDialog onCreated={vi.fn()} />);

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
    render(<ReleaseDialog onCreated={vi.fn()} />);

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
    render(<ReleaseDialog onCreated={vi.fn()} />);

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

  it("keeps the release dialog open when Escape closes the tag options", async () => {
    api.options.mockResolvedValue(releaseOptions());
    render(<ReleaseDialog onCreated={vi.fn()} />);

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
    render(<ReleaseDialog onCreated={vi.fn()} />);

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
    render(<ReleaseDialog onCreated={vi.fn()} />);

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
    render(<ReleaseDialog onCreated={vi.fn()} />);

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
    render(<ReleaseDialog onCreated={vi.fn()} />);

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
    fireEvent.click(screen.getByRole("button", { name: "Publish release" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The latest repository tag changed. Reload options.",
    );
    expect(api.create).toHaveBeenCalledWith(
      {
        expectedLatestTag: "v1.2.3",
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
    render(<ReleaseDialog onCreated={onCreated} />);

    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Release tag")).toHaveValue("v1.2.4"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review release" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish release" }));

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
