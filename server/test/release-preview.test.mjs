import { describe, expect, it, vi } from "vitest";

import { createReleaseService } from "../releases.mjs";

const TARGET = "1234567890abcdef1234567890abcdef12345678";
const NEXT_TARGET = "2234567890abcdef1234567890abcdef12345678";
const REQUEST = {
  expectedLatestTag: "v1.2.3",
  repository: "owner/repo",
  tag: "v1.2.4",
};

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function snapshot(viewerLogin = "viewer", repositories = ["owner/repo"]) {
  return {
    notReady: [],
    partial: false,
    ready: repositories.map((repository) => ({
      repository,
      repositoryUrl: `https://github.com/${repository}`,
    })),
    stale: false,
    viewerLogin,
  };
}

function serviceFixture({
  body = [
    "## What’s Changed",
    "* First fix by @alice in https://github.com/owner/repo/pull/2",
    "* [Second fix](https://github.com/owner/repo/pull/9)",
  ].join("\n"),
  generated,
  repositories = ["owner/repo"],
} = {}) {
  let currentBody = body;
  let target = TARGET;
  let viewer = "viewer";
  const executor = {
    action: vi.fn(),
    rest: vi.fn(async (endpoint, options = {}) => {
      if (endpoint === "user") return { login: viewer };
      if (endpoint.startsWith("repos/owner/repo/tags?")) {
        return [{ name: "v1.2.3" }];
      }
      if (endpoint === "repos/owner/repo") return { default_branch: "main" };
      if (endpoint === "repos/owner/repo/commits/main") return { sha: target };
      if (
        endpoint === "repos/owner/repo/releases/generate-notes" &&
        options.method === "POST"
      ) {
        if (generated) return generated.promise;
        return { body: currentBody, name: "Generated v1.2.4" };
      }
      throw new Error(`Unexpected endpoint ${endpoint}`);
    }),
  };
  const service = createReleaseService({
    executor,
    loadMergedPulls: async () => ({ incomplete: false, items: [] }),
    loadOpenPulls: async () => snapshot(viewer, repositories),
  });
  return {
    executor,
    service,
    setBody: (value) => {
      currentBody = value;
    },
    setTarget: (value) => {
      target = value;
    },
    setViewer: (value) => {
      viewer = value;
    },
  };
}

describe("release preview", () => {
  it("returns every canonical generated-notes pull without per-pull REST reads", async () => {
    const body = [
      "## What’s Changed",
      "* First fix by @alice in https://github.com/owner/repo/pull/2",
      "* [Second fix](https://github.com/owner/repo/pull/9)",
    ].join("\n");
    const { executor, service } = serviceFixture({ body });

    await expect(service.preview(REQUEST)).resolves.toMatchObject({
      baseTag: "v1.2.3",
      body,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      name: "Generated v1.2.4",
      pulls: [
        {
          number: 2,
          title: "First fix",
          url: "https://github.com/owner/repo/pull/2",
        },
        {
          number: 9,
          title: "Second fix",
          url: "https://github.com/owner/repo/pull/9",
        },
      ],
      repository: "owner/repo",
      tag: "v1.2.4",
      targetOid: TARGET,
    });
    expect(
      executor.rest.mock.calls.some(([endpoint]) =>
        /\/pulls\/\d+$/.test(endpoint),
      ),
    ).toBe(false);
    expect(executor.rest).toHaveBeenCalledWith(
      "repos/owner/repo/releases/generate-notes",
      {
        fields: {
          previous_tag_name: "v1.2.3",
          tag_name: "v1.2.4",
          target_commitish: TARGET,
        },
        method: "POST",
        validate: expect.any(Function),
      },
    );
  });

  it("accepts a generated release with zero pull requests", async () => {
    const { service } = serviceFixture({
      body: "## Notes\n\nMaintenance only.",
    });

    await expect(service.preview(REQUEST)).resolves.toMatchObject({
      pulls: [],
      targetOid: TARGET,
    });
  });

  it("coalesces only an exact authorized viewer and release identity", async () => {
    const generated = deferred();
    const fixture = serviceFixture({ generated });

    const first = fixture.service.preview(REQUEST);
    const second = fixture.service.preview(REQUEST);
    await vi.waitFor(() => {
      expect(
        fixture.executor.rest.mock.calls.filter(
          ([endpoint]) =>
            endpoint === "repos/owner/repo/releases/generate-notes",
        ),
      ).toHaveLength(1);
    });
    generated.resolve({
      body: "https://github.com/owner/repo/pull/7",
      name: "Generated v1.2.4",
    });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    fixture.setTarget(NEXT_TARGET);
    await fixture.service.preview(REQUEST);
    expect(
      fixture.executor.rest.mock.calls.filter(
        ([endpoint]) => endpoint === "repos/owner/repo/releases/generate-notes",
      ),
    ).toHaveLength(2);

    fixture.setViewer("other-viewer");
    await fixture.service.preview(REQUEST);
    expect(
      fixture.executor.rest.mock.calls.filter(
        ([endpoint]) => endpoint === "repos/owner/repo/releases/generate-notes",
      ),
    ).toHaveLength(3);
  });

  it("authorizes repository membership before generating notes", async () => {
    const { executor, service } = serviceFixture({ repositories: [] });

    await expect(service.preview(REQUEST)).rejects.toMatchObject({
      code: "repository_not_allowed",
      status: 403,
    });
    expect(
      executor.rest.mock.calls.some(
        ([endpoint]) => endpoint === "repos/owner/repo/releases/generate-notes",
      ),
    ).toBe(false);
  });

  it("rejects changed pull membership before creating a tag", async () => {
    const fixture = serviceFixture({
      body: "Fix one in https://github.com/owner/repo/pull/1",
    });
    const preview = await fixture.service.preview(REQUEST);
    fixture.setBody("Fix two in https://github.com/owner/repo/pull/2");

    await expect(
      fixture.service.create({
        ...REQUEST,
        prerelease: false,
        preview,
      }),
    ).rejects.toMatchObject({
      code: "release_preview_changed",
      status: 409,
    });
    expect(
      fixture.executor.rest.mock.calls.some(
        ([endpoint, options]) =>
          endpoint === "repos/owner/repo/git/tags" && options.method === "POST",
      ),
    ).toBe(false);
  });
});
