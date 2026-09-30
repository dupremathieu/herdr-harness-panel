export interface GitInfo {
	/** Current branch, "detached", or "no-git" outside a repository. */
	branch: string;
	/** Name of the linked worktree, or null in the main worktree / outside git. */
	worktree: string | null;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
	try {
		const proc = Bun.spawn(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "ignore",
		});
		const out = (await new Response(proc.stdout).text()).trim();
		return (await proc.exited) === 0 ? out : null;
	} catch {
		return null;
	}
}

/** Branch and linked-worktree name for `cwd`. Never throws. */
export async function getGitStatus(cwd: string): Promise<GitInfo> {
	const [branch, gitDir, commonDir, top] = await Promise.all([
		git(cwd, ["branch", "--show-current"]),
		git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]),
		git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
		git(cwd, ["rev-parse", "--show-toplevel"]),
	]);
	if (gitDir === null) return { branch: "no-git", worktree: null };
	const linked = commonDir !== null && gitDir !== commonDir;
	return {
		branch: branch || "detached",
		worktree: linked ? (top?.split("/").pop() ?? null) : null,
	};
}
