import { syncMergedPullRequest, ticketFromPullRequest } from './index';

const WORKSPACE = 'romain-project';

try {
  const apiKey = process.env.PLANE_API_KEY ?? '';
  const title = process.env.PR_TITLE ?? '';
  const branch = process.env.PR_BRANCH ?? '';
  // A pull request without a ticket id never reaches Plane, so it needs no key.
  if (!apiKey && ticketFromPullRequest(title, branch)) throw new Error('PLANE_API_KEY is not set');
  await syncMergedPullRequest({
    title,
    branch,
    apiKey,
    baseUrl: process.env.PLANE_API_URL || 'https://api.plane.so',
    workspace: WORKSPACE,
    log: console.log,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
