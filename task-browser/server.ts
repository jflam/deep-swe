import { readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

type TomlValue = string | number | boolean;
type TomlSection = Record<string, TomlValue>;
type ParsedToml = Record<string, TomlSection>;

type PatchStats = {
  files: number;
  additions: number;
  deletions: number;
};

type TaskSummary = {
  id: string;
  title: string;
  description: string;
  language: string;
  category: string;
  repositoryUrl: string;
  baseCommitHash: string;
  promptPreview: string;
  promptLines: number;
  solutionPatchStats: PatchStats;
};

const repoRoot = resolve(import.meta.dir, "..");
const tasksRoot = join(repoRoot, "tasks");
const clientRoot = join(import.meta.dir, "client");
const port = Number.parseInt(Bun.env.PORT ?? "4173", 10);

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function notFound(): Response {
  return jsonResponse({ error: "Not found" }, 404);
}

function parseTomlValue(value: string): TomlValue {
  const trimmed = value.trim();
  const quote = trimmed[0];

  if (
    (quote === `"` || quote === `'`) &&
    trimmed.length >= 2 &&
    trimmed[trimmed.length - 1] === quote
  ) {
    return trimmed.slice(1, -1);
  }

  if (trimmed === "true") {
    return true;
  }

  if (trimmed === "false") {
    return false;
  }

  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : trimmed;
}

function parseToml(text: string): ParsedToml {
  const parsed: ParsedToml = {};
  let section = "";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      parsed[section] ??= {};
      continue;
    }

    const assignment = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!assignment) {
      continue;
    }

    parsed[section] ??= {};
    parsed[section][assignment[1]] = parseTomlValue(assignment[2]);
  }

  return parsed;
}

async function readText(relativePath: string): Promise<string> {
  const file = Bun.file(join(repoRoot, relativePath));
  if (!(await file.exists())) {
    return "";
  }
  return await file.text();
}

function asString(value: TomlValue | undefined): string {
  return value == null ? "" : String(value);
}

function countLines(text: string): number {
  if (!text) {
    return 0;
  }
  return text.split(/\r?\n/).length;
}

function summarizePatch(patch: string): PatchStats {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  let inHunk = false;

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      files += 1;
      inHunk = false;
      continue;
    }

    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }

    if (!inHunk) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }

  return { files, additions, deletions };
}

function previewPrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 220);
}

async function loadTaskSummary(id: string): Promise<TaskSummary | null> {
  const taskToml = await readText(`tasks/${id}/task.toml`);
  if (!taskToml) {
    return null;
  }

  const prompt = await readText(`tasks/${id}/instruction.md`);
  const solutionPatch = await readText(`tasks/${id}/solution/solution.patch`);
  const parsed = parseToml(taskToml);
  const metadata = parsed.metadata ?? {};

  return {
    id,
    title: asString(metadata.display_title) || id,
    description: asString(metadata.display_description),
    language: asString(metadata.language),
    category: asString(metadata.category),
    repositoryUrl: asString(metadata.repository_url),
    baseCommitHash: asString(metadata.base_commit_hash),
    promptPreview: previewPrompt(prompt),
    promptLines: countLines(prompt),
    solutionPatchStats: summarizePatch(solutionPatch),
  };
}

async function listTasks(): Promise<TaskSummary[]> {
  const entries = await readdir(tasksRoot, { withFileTypes: true });
  const summaries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => loadTaskSummary(entry.name)),
  );

  return summaries
    .filter((summary): summary is TaskSummary => summary != null)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function isSafeTaskId(taskId: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(taskId);
}

async function loadTaskDetail(taskId: string): Promise<Response> {
  if (!isSafeTaskId(taskId)) {
    return jsonResponse({ error: "Invalid task id" }, 400);
  }

  const summary = await loadTaskSummary(taskId);
  if (!summary) {
    return notFound();
  }

  const [taskToml, prompt, solutionPatch, testPatch, testScript, dockerfile] =
    await Promise.all([
      readText(`tasks/${taskId}/task.toml`),
      readText(`tasks/${taskId}/instruction.md`),
      readText(`tasks/${taskId}/solution/solution.patch`),
      readText(`tasks/${taskId}/tests/test.patch`),
      readText(`tasks/${taskId}/tests/test.sh`),
      readText(`tasks/${taskId}/environment/Dockerfile`),
    ]);

  return jsonResponse({
    ...summary,
    taskToml,
    prompt,
    solutionPatch,
    testPatch,
    testScript,
    dockerfile,
    testPatchStats: summarizePatch(testPatch),
  });
}

async function serveClientScript(): Promise<Response> {
  const result = await Bun.build({
    entrypoints: [join(clientRoot, "app.ts")],
    target: "browser",
    minify: false,
    sourcemap: "inline",
    write: false,
  });

  if (!result.success) {
    return new Response(
      result.logs.map((log) => log.message).join("\n") || "Client build failed",
      { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const output = result.outputs[0];
  return new Response(await output.text(), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function serveStatic(pathname: string): Promise<Response> {
  if (pathname === "/static/app.js") {
    return serveClientScript();
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/static\//, "");
  const filePath = join(clientRoot, relativePath);
  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    return notFound();
  }

  return new Response(file, {
    headers: {
      "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
    },
  });
}

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/tasks") {
        return jsonResponse({ tasks: await listTasks() });
      }

      const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
      if (taskMatch) {
        return loadTaskDetail(decodeURIComponent(taskMatch[1]));
      }

      if (url.pathname === "/" || url.pathname.startsWith("/static/")) {
        return serveStatic(url.pathname);
      }

      return serveStatic("/");
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : "Unknown error";
      return jsonResponse({ error: message }, 500);
    }
  },
});

console.log(`DeepSWE task browser running at http://localhost:${port}`);
