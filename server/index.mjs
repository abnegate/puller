import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createArtifactAuthorizer } from "./authorization.mjs";
import { createSnapshotCache } from "./cache.mjs";
import { createCheckLogsService } from "./check-logs.mjs";
import { createClaudeRunManager } from "./claude.mjs";
import { createConflictRepairManager } from "./conflict-repair.mjs";
import { createDiffService } from "./diff.mjs";
import { createGithubExecutor } from "./executor.mjs";
import { createGithubLoader } from "./github.mjs";
import {
  assertProductionBuild,
  createRequestListener,
  createStaticHandler,
} from "./http.mjs";
import { createMergeService } from "./merge.mjs";
import { createReadinessSnapshot } from "./readiness.mjs";
import { createReleaseService } from "./releases.mjs";
import { createRunScheduler } from "./scheduler.mjs";
import { createTaskManager } from "./task.mjs";
import {
  createReleaseVerificationManager,
  createVerificationRunManager,
} from "./verification.mjs";
import { createVerificationMemory } from "./verification-memory.mjs";
import {
  createVerificationWorkspaceManager,
  createWorkspaceResolver,
  resolveWorkspaceOptions,
} from "./workspace.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = resolve(ROOT, "dist");
const LOOPBACKS = new Set(["127.0.0.1", "::1", "localhost"]);

function originFor(host, port) {
  const address = host.includes(":") ? `[${host}]` : host;
  return `http://${address}:${port}`;
}

async function closeServer(server) {
  await new Promise((resolveClose, reject) => {
    server.close((error) => {
      if (!error || error.code === "ERR_SERVER_NOT_RUNNING") {
        resolveClose();
        return;
      }
      reject(error);
    });
  });
}

export function resolveServerOptions(environment = process.env) {
  const host = environment.HOST || "127.0.0.1";
  if (!LOOPBACKS.has(host) && environment.ALLOW_EXTERNAL !== "1") {
    throw new Error(
      `Refusing to bind to non-loopback host ${host}. Set ALLOW_EXTERNAL=1 to opt in.`,
    );
  }

  const port = Number(environment.PORT || 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer from 1 to 65535.");
  }

  return { host, port };
}

export function resolveVerificationMemoryRoot(
  environment = process.env,
  homeDirectory,
) {
  const configured = environment.PULLER_VERIFICATION_MEMORY_ROOT?.trim();
  if (configured) return configured;
  return resolve(homeDirectory ?? homedir(), ".puller", "verification-memory");
}

export async function start({
  mode,
  environment = process.env,
  createVite,
  createAuthorization = createArtifactAuthorizer,
  createCheckLogs = createCheckLogsService,
  createDiff = createDiffService,
  createMemory = createVerificationMemory,
  executor,
  graphql,
  loader,
  root = ROOT,
  distPath = DIST,
  createManager = createClaudeRunManager,
  createTask = createTaskManager,
  createRepair = createConflictRepairManager,
  createReleaseVerifier = createReleaseVerificationManager,
  createVerifier = createVerificationRunManager,
  createWorkspace = createWorkspaceResolver,
  createVerificationWorkspace = createVerificationWorkspaceManager,
  workspaceResolver,
  verificationWorkspace,
  verificationMemory = null,
  verificationMemoryRoot,
  homeDirectory,
  actionToken = randomBytes(32).toString("base64url"),
} = {}) {
  if (mode !== "development" && mode !== "production") {
    throw new Error("Start mode must be development or production.");
  }

  const { host, port } = resolveServerOptions(environment);
  const githubExecutor = executor ?? createGithubExecutor();
  const githubLoader =
    loader ??
    createGithubLoader(
      graphql
        ? { executor: githubExecutor, graphql }
        : { executor: githubExecutor },
    );
  const cache = createSnapshotCache({
    load: async () =>
      createReadinessSnapshot(await githubLoader.loadAuthoredPulls()),
  });
  const authorizer = createAuthorization({
    loadCheckAuthorization: githubLoader.loadCheckAuthorization,
    loadPullAuthorization: githubLoader.loadPullAuthorization,
    peek: cache.peek,
  });
  const trustedOrigin = originFor(host, port);
  const executionEnabled =
    LOOPBACKS.has(host) || environment.ALLOW_EXTERNAL_EXECUTION === "1";

  let coordinator = null;
  let checkLogsService = null;
  let diffService = null;
  let mergeService = null;
  let releaseService = null;
  let releaseVerifier = null;
  let repairManager = null;
  let resolver = null;
  let runManager = null;
  let taskManager = null;
  let verifier = null;
  let memory = null;
  let verifyWorkspace = null;
  try {
    coordinator = createRunScheduler();
    taskManager = createTask({
      environment,
      scheduler: coordinator,
    });
    checkLogsService = createCheckLogs({
      authorizer,
      executor: githubExecutor,
    });
    diffService = createDiff({
      authorizer,
      executor: githubExecutor,
    });
    releaseService = createReleaseService({
      executor: githubExecutor,
      readinessCache: cache,
      invalidateReadiness: () => undefined,
      refetch: () => cache.getFresh(),
    });
    repairManager = createRepair({
      coordinator,
      executor: githubExecutor,
      loadPull: githubLoader.loadPull,
      refetch: () => cache.getFresh(),
    });
    mergeService = createMergeService({
      executor: githubExecutor,
      loadPull: githubLoader.loadPull,
      repairManager,
      invalidate: () => releaseService.invalidate(),
      refetch: () => cache.getFresh(),
    });
    resolver =
      workspaceResolver ??
      createWorkspace(resolveWorkspaceOptions(environment));
    runManager = createManager({
      cache,
      coordinator,
      diffService,
      loadPull: githubLoader.loadPull,
      loadReviewAuthorization: githubLoader.loadPullAuthorization,
      refreshReadiness: () => cache.getFresh(),
      resolver,
    });
    verifyWorkspace =
      verificationWorkspace ??
      createVerificationWorkspace(resolveWorkspaceOptions(environment));
    memory =
      verificationMemory ??
      createMemory({
        root:
          verificationMemoryRoot ??
          resolveVerificationMemoryRoot(environment, homeDirectory),
      });
    verifier = createVerifier({
      coordinator,
      memory,
      resolveRelease: releaseService.resolveVerification,
      workspace: verifyWorkspace,
    });
    releaseVerifier = createReleaseVerifier({
      resolveRelease: releaseService.resolveReleaseVerifications,
      verifier,
    });
  } catch (error) {
    await Promise.allSettled([
      Promise.resolve().then(() => releaseVerifier?.shutdown?.()),
      Promise.resolve().then(() => repairManager?.shutdown?.()),
      Promise.resolve().then(() => runManager?.shutdown?.()),
      Promise.resolve().then(() => taskManager?.close?.()),
      Promise.resolve().then(() => verifier?.shutdown?.()),
    ]);
    coordinator?.shutdown?.();
    throw error;
  }

  let fallback = (_request, response) => {
    response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("The client is still starting.");
  };
  const server = createServer(
    createRequestListener({
      cache,
      runManager,
      taskManager,
      checkLogsService,
      diffService,
      mergeService,
      repairManager,
      releaseService,
      releaseVerificationManager: releaseVerifier,
      verificationManager: verifier,
      actionToken,
      trustedOrigin,
      executionEnabled,
      fallback: (request, response) => fallback(request, response),
    }),
  );

  let vite = null;
  let closing = null;
  const close = () => {
    if (!closing) {
      closing = (async () => {
        const managerResults = await Promise.allSettled([
          releaseVerifier.shutdown(),
          repairManager.shutdown(),
          runManager.shutdown(),
          taskManager.close(),
          verifier.shutdown(),
        ]);
        coordinator.shutdown();
        const serverResult = await Promise.allSettled([
          closeServer(server),
          vite?.close(),
        ]);
        const failed = [...managerResults, ...serverResult].find(
          (result) => result.status === "rejected",
        );
        if (failed) throw failed.reason;
      })();
    }
    return closing;
  };

  try {
    if (mode === "development") {
      const create = createVite ?? (await import("vite")).createServer;
      vite = await create({
        root,
        appType: "spa",
        server: {
          middlewareMode: { server },
        },
      });
      fallback = vite.middlewares;
    } else {
      await assertProductionBuild(distPath);
      fallback = createStaticHandler({ distPath });
    }

    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolveListen();
      });
    });
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }

  return {
    actionToken,
    authorizer,
    cache,
    checkLogsService,
    close,
    coordinator,
    diffService,
    executor: githubExecutor,
    host,
    loader: githubLoader,
    mergeService,
    port,
    releaseService,
    releaseVerificationManager: releaseVerifier,
    repairManager,
    runManager,
    taskManager,
    server,
    verificationManager: verifier,
    verificationMemory: memory,
    verificationWorkspace: verifyWorkspace,
    vite,
  };
}

async function main() {
  const mode = process.argv.includes("--dev")
    ? "development"
    : process.argv.includes("--production")
      ? "production"
      : null;

  if (!mode) {
    throw new Error("Use --dev or --production.");
  }

  const running = await start({ mode });
  console.log(`Authored pulls ready at http://${running.host}:${running.port}`);

  const shutdown = async () => {
    try {
      await running.close();
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry === import.meta.url) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Server failed to start.",
    );
    process.exitCode = 1;
  });
}
