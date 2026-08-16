import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitWorker } from "../../src/workers/git-worker.js";

// Mock simple-git
const mockGitInstance = {
  branch: vi.fn(),
  branchLocal: vi.fn(),
  revparse: vi.fn(),
  status: vi.fn(),
  checkoutLocalBranch: vi.fn(),
  checkout: vi.fn(),
  add: vi.fn(),
  commit: vi.fn(),
  diff: vi.fn(),
  stash: vi.fn(),
  tags: vi.fn(),
  log: vi.fn(),
  raw: vi.fn(),
  checkIsRepo: vi.fn(),
};

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(() => mockGitInstance),
}));

// Mock fs to make existsSync return true for .git directories
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      // Return true for .git directory checks
      if (typeof path === "string" && path.endsWith(".git")) return true;
      return actual.existsSync(path);
    }),
  };
});

describe("GitWorker", () => {
  let worker: GitWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitInstance.checkIsRepo.mockResolvedValue(true);
    worker = new GitWorker();
  });

  describe("stateless pattern", () => {
    it("creates a new SimpleGit instance per method call", async () => {
      const { simpleGit } = await import("simple-git");

      mockGitInstance.status.mockResolvedValue({ current: "main" });
      await worker.getCurrentBranch("/project1");

      mockGitInstance.log.mockResolvedValue({ latest: { hash: "abc123" } });
      await worker.getLastCommitHash("/project2");

      // simpleGit should have been called twice with different paths
      expect(simpleGit).toHaveBeenCalledTimes(2);
      expect(simpleGit).toHaveBeenCalledWith("/project1");
      expect(simpleGit).toHaveBeenCalledWith("/project2");
    });
  });

  describe("getCurrentBranch", () => {
    it("returns the current branch name", async () => {
      mockGitInstance.status.mockResolvedValue({ current: "feature/test" });

      const branch = await worker.getCurrentBranch("/project");
      expect(branch).toBe("feature/test");
    });

    it("returns HEAD when current is null", async () => {
      mockGitInstance.status.mockResolvedValue({ current: null });

      const branch = await worker.getCurrentBranch("/project");
      expect(branch).toBe("HEAD");
    });
  });

  describe("getLastCommitHash", () => {
    it("returns the commit hash", async () => {
      mockGitInstance.log.mockResolvedValue({ latest: { hash: "abc123def456" } });

      const hash = await worker.getLastCommitHash("/project");
      expect(hash).toBe("abc123def456");
    });

    it("returns empty string when no commits", async () => {
      mockGitInstance.log.mockResolvedValue({ latest: null });

      const hash = await worker.getLastCommitHash("/project");
      expect(hash).toBe("");
    });
  });

  describe("getStatus", () => {
    it("returns working tree status", async () => {
      mockGitInstance.status.mockResolvedValue({
        modified: ["src/index.ts"],
        staged: [],
        not_added: [],
        created: [],
        deleted: [],
        renamed: [],
        conflicted: [],
        files: [{ path: "src/index.ts" }],
        isClean: vi.fn(() => false),
      });

      const status = await worker.getStatus("/project");
      expect(status.modified).toContain("src/index.ts");
    });
  });

  describe("createBranch", () => {
    it("creates and checks out a new branch", async () => {
      mockGitInstance.branchLocal.mockResolvedValue({ all: ["main"] });
      mockGitInstance.checkoutLocalBranch.mockResolvedValue(undefined);

      await worker.createBranch("/project", "feature/new");

      expect(mockGitInstance.checkoutLocalBranch).toHaveBeenCalledWith("feature/new");
    });

    it("throws when branch already exists", async () => {
      mockGitInstance.branchLocal.mockResolvedValue({ all: ["main", "feature/new"] });

      await expect(worker.createBranch("/project", "feature/new")).rejects.toThrow("Branch already exists");
      expect(mockGitInstance.checkoutLocalBranch).not.toHaveBeenCalled();
    });
  });

  describe("commitFiles", () => {
    it("stages only requested files and commits", async () => {
      mockGitInstance.add.mockResolvedValue(undefined);
      mockGitInstance.commit.mockResolvedValue({ commit: "abc123" });

      const hash = await worker.commitFiles(
        "/project",
        ["pom.xml", "module/pom.xml"],
        "fix: update dependency",
      );

      expect(mockGitInstance.add).toHaveBeenCalledWith(["pom.xml", "module/pom.xml"]);
      expect(mockGitInstance.commit).toHaveBeenCalledWith("fix: update dependency");
      expect(hash).toBe("abc123");
    });
  });

  describe("isGitRepo", () => {
    it("returns true for a git repository", async () => {
      const result = await worker.isGitRepo("/project");
      expect(result).toBe(true);
    });

    it("returns false when Git rejects the path", async () => {
      mockGitInstance.checkIsRepo.mockRejectedValueOnce(new Error("not a repository"));
      await expect(worker.isGitRepo("/project")).resolves.toBe(false);
    });
  });
});
