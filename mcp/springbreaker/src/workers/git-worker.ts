import { simpleGit, type SimpleGit } from 'simple-git';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
    const gitDir = join(projectPath, '.git');
    if (!existsSync(gitDir)) {
      throw new GitError('Not a git repository');
    }
    return simpleGit(projectPath);
  }

  // Check if git is available and project is a git repo
  async isGitRepo(projectPath: string): Promise<boolean> {
    return existsSync(join(projectPath, '.git'));
  }

  // Get current branch
  async getCurrentBranch(projectPath: string): Promise<string> {
    const git = this.getGit(projectPath);
    const status = await git.status();
    return status.current || 'HEAD';
  }

  // Get branch list
  async getBranches(projectPath: string): Promise<string[]> {
    const git = this.getGit(projectPath);
    const branches = await git.branchLocal();
    return branches.all;
  }

  // Check if working directory is clean
  async isClean(projectPath: string): Promise<boolean> {
    const git = this.getGit(projectPath);
    const status = await git.status();
    return status.isClean();
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

  // Switch to branch
  async checkout(projectPath: string, branchName: string): Promise<void> {
    const git = this.getGit(projectPath);
    await git.checkout(branchName);
    log.info(`Switched to branch: ${branchName}`);
  }

  // Stage files
  async add(projectPath: string, files: string | string[]): Promise<void> {
    const git = this.getGit(projectPath);
    await git.add(files);
    log.info(`Staged files: ${Array.isArray(files) ? files.join(', ') : files}`);
  }

  // Stage all changes
  async addAll(projectPath: string): Promise<void> {
    const git = this.getGit(projectPath);
    await git.add('.');
    log.info('Staged all changes');
  }

  // Commit changes
  async commit(projectPath: string, message: string): Promise<string> {
    const git = this.getGit(projectPath);
    const result = await git.commit(message);
    log.info(`Committed: ${result.commit}`);
    return result.commit;
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

  // Get diff
  async getDiff(projectPath: string, staged: boolean = false): Promise<string> {
    const git = this.getGit(projectPath);
    if (staged) {
      return git.diff(['--cached']);
    }
    return git.diff();
  }

  // Get diff for specific file
  async getFileDiff(projectPath: string, filePath: string): Promise<string> {
    const git = this.getGit(projectPath);
    return git.diff([filePath]);
  }

  // Restore file to last commit
  async restore(projectPath: string, filePath: string): Promise<void> {
    const git = this.getGit(projectPath);
    await git.checkout(['--', filePath]);
    log.info(`Restored file: ${filePath}`);
  }

  // Restore all changes
  async restoreAll(projectPath: string): Promise<void> {
    const git = this.getGit(projectPath);
    await git.checkout(['.']);
    log.info('Restored all changes');
  }

  // Create a tag
  async createTag(projectPath: string, tagName: string, message?: string): Promise<void> {
    const git = this.getGit(projectPath);
    if (message) {
      await git.addAnnotatedTag(tagName, message);
    } else {
      await git.addTag(tagName);
    }
    log.info(`Created tag: ${tagName}`);
  }

  // Get tags
  async getTags(projectPath: string): Promise<string[]> {
    const git = this.getGit(projectPath);
    const tags = await git.tags();
    return tags.all;
  }

  // Get last commit hash
  async getLastCommitHash(projectPath: string): Promise<string> {
    const git = this.getGit(projectPath);
    const logResult = await git.log({ maxCount: 1 });
    return logResult.latest?.hash || '';
  }

  // Get commit log
  async getLog(
    projectPath: string,
    options: { maxCount?: number; from?: string; to?: string } = {}
  ): Promise<Array<{
    hash: string;
    date: string;
    message: string;
    author_name: string;
    author_email: string;
  }>> {
    const git = this.getGit(projectPath);
    const logResult = await git.log(options);
    return logResult.all.map(commit => ({
      hash: commit.hash,
      date: commit.date,
      message: commit.message,
      author_name: commit.author_name,
      author_email: commit.author_email,
    }));
  }

  // Check if file is tracked
  async isFileTracked(projectPath: string, filePath: string): Promise<boolean> {
    try {
      const git = this.getGit(projectPath);
      await git.catFile(['-t', filePath]);
      return true;
    } catch {
      return false;
    }
  }

  // Stash changes
  async stash(projectPath: string, message?: string): Promise<void> {
    const git = this.getGit(projectPath);
    if (message) {
      await git.stash(['push', '-m', message]);
    } else {
      await git.stash();
    }
    log.info('Stashed changes');
  }

  // Pop stash
  async stashPop(projectPath: string): Promise<void> {
    const git = this.getGit(projectPath);
    await git.stash(['pop']);
    log.info('Popped stash');
  }

  /**
   * @deprecated No longer needed — each method creates its own git instance.
   * Kept for backward compatibility with existing callers.
   */
  async init(projectPath: string): Promise<void> {
    this.getGit(projectPath); // Validate it's a git repo
    log.debug(`Git validated for: ${projectPath}`);
  }
}
