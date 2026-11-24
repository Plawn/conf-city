// Exits non-zero unless GitHub's `ci` workflow passed on this commit (`just release` guard).
const sha = (await Bun.$`git rev-parse HEAD`.text()).trim();
const remote = (await Bun.$`git remote get-url origin`.text()).trim();
const repo = remote.match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1];
if (!repo) {
  throw new Error(`origin is not a GitHub remote: ${remote}`);
}
const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs?head_sha=${sha}`);
const { workflow_runs: runs = [] } = (await res.json()) as {
  workflow_runs?: { name: string; status: string; conclusion: string | null }[];
};
const ci = runs.find((r) => r.name === "ci");
if (ci?.conclusion !== "success") {
  console.error(
    `ci on ${sha.slice(0, 7)}: ${ci ? `${ci.status} ${ci.conclusion ?? ""}` : "no run — push main first"}`,
  );
  process.exit(1);
}
