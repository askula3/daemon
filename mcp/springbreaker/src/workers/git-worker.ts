import { simpleGit, type SimpleGit } from 'simple-git';
import { createChildLogger } from '../utils/logger.js';
import { GitError } from '../utils/errors.js';

const log = createChildLogger('GitWorker');

/**
 * GitWorker is stateless — each method creates a fresh SimpleGit instance
 * for the given projectPath. This avoids shared mutable state across
 * concurrent tool calls in the MCP server.
 */
export class GitWorker {

  // Create a fresh SimpleGit instance for a project
  private getGit(projectPath: string): SimpleGit {
    return simpleGit(projectPath);
  }

  // Check if git is available and project is a git repo
  async isGitRepo(projectPath: string): Promise<boolean> {
    try {
      return await this.getGit(projectPath).checkIsRepo();
    } catch {
      return false;
    }
  }

  // Get current branch
  async getCurrentBranch(projectPath: string): Promise<string> {
    const git = this.getGit(projectPath);
    const status = await git.status();
    return status.current || 'HEAD';
  }

  // Get status
  async getStatus(projectPath: string): Promise<{
    current: string | null;
    tracking: string | null;
    ahead: number;
    behind: number;
    staged: string[];
    modified: string[];
    notAdded: string[];
    changed: string[];
    isClean: boolean;
  }> {
    const git = this.getGit(projectPath);
    const status = await git.status();

    return {
      current: status.current,
      tracking: status.tracking,
      ahead: status.ahead,
      behind: status.behind,
      staged: status.staged,
      modified: status.modified,
      notAdded: status.not_added,
      changed: status.files.map((file) => file.path),
      isClean: status.isClean(),
    };
  }

  // Create a new branch
  async createBranch(projectPath: string, branchName: string): Promise<void> {
    const git = this.getGit(projectPath);

    // Check if branch exists
    const branches = await git.branchLocal();
    if (branches.all.includes(branchName)) {
      throw new GitError(`Branch already exists: ${branchName}`);
    }

    await git.checkoutLocalBranch(branchName);
    log.info(`Created branch: ${branchName}`);
  }

  // Create a commit with specific files
  async commitFiles(
    projectPath: string,
    files: string[],
    message: string
  ): Promise<string> {
    const git = this.getGit(projectPath);
    await git.add(files);
    const result = await git.commit(message);
    log.info(`Committed ${files.length} files: ${result.commit}`);
    return result.commit;
  }

  // Get last commit hash
  async getLastCommitHash(projectPath: string): Promise<string> {
    const git = this.getGit(projectPath);
    const logResult = await git.log({ maxCount: 1 });
    return logResult.latest?.hash || '';
  }

}
