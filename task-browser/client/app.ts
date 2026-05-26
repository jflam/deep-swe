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

type TaskDetail = TaskSummary & {
  taskToml: string;
  prompt: string;
  solutionPatch: string;
  testPatch: string;
  testPatchStats: PatchStats;
  testScript: string;
  dockerfile: string;
};

type DiffLine = {
  kind: "context" | "add" | "delete" | "hunk" | "meta";
  oldNumber: number | null;
  newNumber: number | null;
  content: string;
};

type PatchFile = {
  oldPath: string;
  newPath: string;
  header: string[];
  lines: DiffLine[];
  additions: number;
  deletions: number;
  isNew: boolean;
  isDeleted: boolean;
};

const state: {
  tasks: TaskSummary[];
  selectedTaskId: string | null;
  activePatch: "solution" | "tests";
  search: string;
  language: string;
  category: string;
} = {
  tasks: [],
  selectedTaskId: null,
  activePatch: "solution",
  search: "",
  language: "all",
  category: "all",
};

const taskCount = mustGet<HTMLElement>("task-count");
const taskList = mustGet<HTMLElement>("task-list");
const taskDetail = mustGet<HTMLElement>("task-detail");
const emptyState = mustGet<HTMLElement>("empty-state");
const searchInput = mustGet<HTMLInputElement>("search");
const languageFilter = mustGet<HTMLSelectElement>("language-filter");
const categoryFilter = mustGet<HTMLSelectElement>("category-filter");
let selectionRequestId = 0;

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing #${id}`);
  }
  return element as T;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatCategory(category: string): string {
  return category.replace(/_/g, " ");
}

function shortCommit(commit: string): string {
  return commit ? commit.slice(0, 10) : "";
}

function taskHash(taskId: string): string {
  return `#task/${encodeURIComponent(taskId)}`;
}

function taskIdFromHash(): string {
  const hash = location.hash.slice(1);
  if (!hash) {
    return "";
  }

  if (hash.startsWith("task/")) {
    return decodeURIComponent(hash.slice("task/".length));
  }

  return state.tasks.some((task) => task.id === hash) ? hash : "";
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function renderFilters(): void {
  const languages = uniqueSorted(state.tasks.map((task) => task.language));
  const categories = uniqueSorted(state.tasks.map((task) => task.category));

  languageFilter.innerHTML = [
    `<option value="all">All languages</option>`,
    ...languages.map((language) => `<option value="${escapeHtml(language)}">${escapeHtml(language)}</option>`),
  ].join("");

  categoryFilter.innerHTML = [
    `<option value="all">All categories</option>`,
    ...categories.map(
      (category) =>
        `<option value="${escapeHtml(category)}">${escapeHtml(formatCategory(category))}</option>`,
    ),
  ].join("");
}

function filteredTasks(): TaskSummary[] {
  const terms = state.search
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  return state.tasks.filter((task) => {
    if (state.language !== "all" && task.language !== state.language) {
      return false;
    }

    if (state.category !== "all" && task.category !== state.category) {
      return false;
    }

    const haystack = [
      task.id,
      task.title,
      task.description,
      task.language,
      task.category,
      task.repositoryUrl,
    ]
      .join(" ")
      .toLowerCase();

    return terms.every((term) => haystack.includes(term));
  });
}

function renderTaskList(): void {
  const tasks = filteredTasks();
  taskCount.textContent = `${tasks.length} of ${state.tasks.length} tasks`;

  if (tasks.length === 0) {
    taskList.innerHTML = `<div class="no-results">No matching tasks.</div>`;
    return;
  }

  taskList.innerHTML = tasks
    .map((task) => {
      const selected = task.id === state.selectedTaskId ? " selected" : "";
      return `
        <a class="task-row${selected}" href="${taskHash(task.id)}" data-task-id="${escapeHtml(task.id)}">
          <span class="task-row-title">${escapeHtml(task.title)}</span>
          <span class="task-row-id">${escapeHtml(task.id)}</span>
          <span class="task-row-meta">
            <span>${escapeHtml(task.language)}</span>
            <span>${escapeHtml(formatCategory(task.category))}</span>
            <span>${task.solutionPatchStats.files} files</span>
          </span>
        </a>
      `;
    })
    .join("");
}

function parseGitPath(line: string, prefix: "--- " | "+++ "): string {
  const path = line.slice(prefix.length).trim();
  if (path === "/dev/null") {
    return path;
  }
  return path.replace(/^[ab]\//, "");
}

function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const rawLine of patch.split(/\r?\n/)) {
    if (rawLine.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(rawLine);
      current = {
        oldPath: match?.[1] ?? "",
        newPath: match?.[2] ?? "",
        header: [rawLine],
        lines: [],
        additions: 0,
        deletions: 0,
        isNew: false,
        isDeleted: false,
      };
      files.push(current);
      inHunk = false;
      continue;
    }

    if (!current) {
      continue;
    }

    if (rawLine.startsWith("--- ")) {
      current.oldPath = parseGitPath(rawLine, "--- ");
      current.header.push(rawLine);
      continue;
    }

    if (rawLine.startsWith("+++ ")) {
      current.newPath = parseGitPath(rawLine, "+++ ");
      current.header.push(rawLine);
      continue;
    }

    if (rawLine === "new file mode 100644" || rawLine.startsWith("new file mode ")) {
      current.isNew = true;
      current.header.push(rawLine);
      continue;
    }

    if (rawLine.startsWith("deleted file mode ")) {
      current.isDeleted = true;
      current.header.push(rawLine);
      continue;
    }

    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(rawLine);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      current.lines.push({
        kind: "hunk",
        oldNumber: null,
        newNumber: null,
        content: rawLine,
      });
      continue;
    }

    if (!inHunk) {
      current.header.push(rawLine);
      continue;
    }

    const marker = rawLine[0] ?? " ";
    const content = rawLine.slice(1);

    if (marker === "+") {
      current.additions += 1;
      current.lines.push({
        kind: "add",
        oldNumber: null,
        newNumber: newLine,
        content,
      });
      newLine += 1;
      continue;
    }

    if (marker === "-") {
      current.deletions += 1;
      current.lines.push({
        kind: "delete",
        oldNumber: oldLine,
        newNumber: null,
        content,
      });
      oldLine += 1;
      continue;
    }

    if (marker === " ") {
      current.lines.push({
        kind: "context",
        oldNumber: oldLine,
        newNumber: newLine,
        content,
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    current.lines.push({
      kind: "meta",
      oldNumber: null,
      newNumber: null,
      content: rawLine,
    });
  }

  return files;
}

function renderMetadata(task: TaskDetail): string {
  const repoLink = task.repositoryUrl
    ? `<a href="${escapeHtml(task.repositoryUrl)}" target="_blank" rel="noreferrer">${escapeHtml(task.repositoryUrl)}</a>`
    : "Unknown";

  return `
    <section class="metadata-grid">
      <div class="metadata-card">
        <span>Language</span>
        <strong>${escapeHtml(task.language || "Unknown")}</strong>
      </div>
      <div class="metadata-card">
        <span>Category</span>
        <strong>${escapeHtml(formatCategory(task.category || "Unknown"))}</strong>
      </div>
      <div class="metadata-card">
        <span>Base commit</span>
        <strong title="${escapeHtml(task.baseCommitHash)}">${escapeHtml(shortCommit(task.baseCommitHash))}</strong>
      </div>
      <div class="metadata-card">
        <span>Repository</span>
        <strong>${repoLink}</strong>
      </div>
    </section>
  `;
}

function renderPrompt(task: TaskDetail): string {
  return `
    <section class="panel prompt-panel">
      <div class="panel-heading">
        <h2>Agent prompt</h2>
        <span>${task.promptLines} lines</span>
      </div>
      <pre class="prompt">${escapeHtml(task.prompt)}</pre>
    </section>
  `;
}

function renderPatchToolbar(task: TaskDetail): string {
  const solutionStats = `${task.solutionPatchStats.files} files, +${task.solutionPatchStats.additions}, -${task.solutionPatchStats.deletions}`;
  const testStats = `${task.testPatchStats.files} files, +${task.testPatchStats.additions}, -${task.testPatchStats.deletions}`;

  return `
    <div class="patch-toolbar">
      <div>
        <h2>Patch review</h2>
        <p>${state.activePatch === "solution" ? "Reference solution patch" : "Verifier test patch"}</p>
      </div>
      <div class="segmented">
        <button class="${state.activePatch === "solution" ? "active" : ""}" data-patch-tab="solution">
          Solution <span>${solutionStats}</span>
        </button>
        <button class="${state.activePatch === "tests" ? "active" : ""}" data-patch-tab="tests">
          Tests <span>${testStats}</span>
        </button>
      </div>
    </div>
  `;
}

function renderPatchFile(file: PatchFile, index: number): string {
  const path = file.newPath === "/dev/null" ? file.oldPath : file.newPath;
  const status = file.isNew ? "Added" : file.isDeleted ? "Deleted" : "Modified";
  const rows = file.lines
    .map((line) => {
      if (line.kind === "hunk") {
        return `
          <tr class="diff-row hunk-row">
            <td class="line-number"></td>
            <td class="line-number"></td>
            <td class="code">${escapeHtml(line.content)}</td>
          </tr>
        `;
      }

      const oldNumber = line.oldNumber == null ? "" : String(line.oldNumber);
      const newNumber = line.newNumber == null ? "" : String(line.newNumber);
      return `
        <tr class="diff-row ${line.kind}">
          <td class="line-number">${oldNumber}</td>
          <td class="line-number">${newNumber}</td>
          <td class="code"><span class="marker">${line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " "}</span>${escapeHtml(line.content)}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <section class="diff-file" id="file-${index}">
      <header class="diff-file-header">
        <div>
          <span class="file-status">${status}</span>
          <strong>${escapeHtml(path)}</strong>
        </div>
        <span class="file-stats">+${file.additions} -${file.deletions}</span>
      </header>
      <table class="diff-table">
        <tbody>${rows}</tbody>
      </table>
    </section>
  `;
}

function renderPatch(task: TaskDetail): string {
  const patch = state.activePatch === "solution" ? task.solutionPatch : task.testPatch;
  const files = parsePatch(patch);

  if (!patch.trim()) {
    return `
      <section class="panel">
        ${renderPatchToolbar(task)}
        <div class="empty-patch">No patch file found for this task.</div>
      </section>
    `;
  }

  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);

  return `
    <section class="panel patch-panel">
      ${renderPatchToolbar(task)}
      <div class="patch-summary">
        <strong>${files.length}</strong> changed files
        <span class="additions">+${additions}</span>
        <span class="deletions">-${deletions}</span>
      </div>
      <nav class="file-jump">
        ${files
          .map((file, index) => {
            const path = file.newPath === "/dev/null" ? file.oldPath : file.newPath;
            return `<a href="#file-${index}">${escapeHtml(path)}</a>`;
          })
          .join("")}
      </nav>
      <div class="diff-files">
        ${files.map(renderPatchFile).join("")}
      </div>
    </section>
  `;
}

function renderArtifacts(task: TaskDetail): string {
  return `
    <details class="panel artifact-panel">
      <summary>Environment and verifier files</summary>
      <div class="artifact-grid">
        <div>
          <h3>task.toml</h3>
          <pre>${escapeHtml(task.taskToml)}</pre>
        </div>
        <div>
          <h3>environment/Dockerfile</h3>
          <pre>${escapeHtml(task.dockerfile)}</pre>
        </div>
        <div>
          <h3>tests/test.sh</h3>
          <pre>${escapeHtml(task.testScript)}</pre>
        </div>
      </div>
    </details>
  `;
}

function renderTaskDetail(task: TaskDetail): void {
  emptyState.hidden = true;
  taskDetail.hidden = false;
  taskDetail.innerHTML = `
    <header class="task-header">
      <div>
        <p class="eyebrow">${escapeHtml(task.id)}</p>
        <h1>${escapeHtml(task.title)}</h1>
        <p>${escapeHtml(task.description)}</p>
      </div>
    </header>
    ${renderMetadata(task)}
    ${renderPrompt(task)}
    ${renderPatch(task)}
    ${renderArtifacts(task)}
  `;
}

async function selectTask(taskId: string): Promise<void> {
  const requestId = ++selectionRequestId;
  state.selectedTaskId = taskId;
  renderTaskList();
  taskDetail.hidden = false;
  emptyState.hidden = true;
  taskDetail.innerHTML = `<div class="loading">Loading ${escapeHtml(taskId)}...</div>`;

  const task = await fetchJson<TaskDetail>(`/api/tasks/${encodeURIComponent(taskId)}`);
  if (requestId !== selectionRequestId) {
    return;
  }
  renderTaskDetail(task);

  const nextHash = taskHash(taskId);
  if (location.hash !== nextHash) {
    history.replaceState(null, "", nextHash);
  }
}

function bindEvents(): void {
  searchInput.addEventListener("input", () => {
    state.search = searchInput.value;
    renderTaskList();
  });

  languageFilter.addEventListener("change", () => {
    state.language = languageFilter.value;
    renderTaskList();
  });

  categoryFilter.addEventListener("change", () => {
    state.category = categoryFilter.value;
    renderTaskList();
  });

  taskList.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-task-id]");
    if (!row) {
      return;
    }

    const taskId = row.dataset.taskId;
    if (!taskId) {
      return;
    }

    event.preventDefault();
    void selectTask(taskId);
  });

  taskDetail.addEventListener("click", (event) => {
    const tab = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-patch-tab]");
    if (!tab) {
      return;
    }

    const patch = tab.dataset.patchTab;
    if (patch !== "solution" && patch !== "tests") {
      return;
    }

    state.activePatch = patch;
    if (state.selectedTaskId) {
      void selectTask(state.selectedTaskId);
    }
  });

  window.addEventListener("hashchange", () => {
    const taskId = taskIdFromHash();
    if (taskId && taskId !== state.selectedTaskId) {
      void selectTask(taskId);
    }
  });
}

async function init(): Promise<void> {
  bindEvents();
  const payload = await fetchJson<{ tasks: TaskSummary[] }>("/api/tasks");
  state.tasks = payload.tasks;
  renderFilters();
  renderTaskList();

  const hashTask = taskIdFromHash();
  const initialTask = state.tasks.some((task) => task.id === hashTask) ? hashTask : state.tasks[0]?.id;
  if (initialTask) {
    await selectTask(initialTask);
  }
}

init().catch((error) => {
  console.error(error);
  emptyState.hidden = false;
  taskDetail.hidden = true;
  emptyState.innerHTML = `
    <h2>Failed to load tasks</h2>
    <p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>
  `;
});
