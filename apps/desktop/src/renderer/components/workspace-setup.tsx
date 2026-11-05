import { useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import type { FailedSetup, Workspace } from '../../shared/api';
import { claimNavigation } from '@/components/navigation-claim';
import { restoreDraft } from '@/components/new-workspace';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';

/** The page of a workspace the main process is still making. */
export function SettingUp({ workspace }: { workspace: Workspace }) {
  return (
    <>
      <PageHeader title={workspace.name} />
      <p className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">Setting up workspace…</p>
    </>
  );
}

// Dismisses the refusal and opens the composer with the send it refused.
function useBackToComposer() {
  const router = useRouter();
  const navigate = useNavigate();
  return async ({ id, project, prompt, agent, base }: FailedSetup) => {
    const mayNavigate = claimNavigation(router.history);
    await window.api.workspaces.dismissSetup(id);
    restoreDraft({ prompt, project, agent, base });
    // The refusal goes first: the sidebar would show it on the composer's page otherwise.
    await router.invalidate();
    if (mayNavigate()) await navigate({ to: '/', search: { project } });
  };
}

const buttonClass = 'h-auto rounded-md px-2 py-[5px] text-xs';

/** The page of a workspace whose worktree could not be created. */
export function SetupRefused({ failed }: { failed: FailedSetup }) {
  const back = useBackToComposer();
  return (
    <>
      <PageHeader title={failed.name} />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="max-w-lg text-xs break-words text-destructive">{failed.message}</p>
        <Button variant="outline" className={buttonClass} onClick={() => void back(failed)}>
          Back to composer
        </Button>
      </div>
    </>
  );
}

/** The refusals under Projects, but the one whose page is open. */
export function RefusedSetups({ failedSetups }: { failedSetups: FailedSetup[] }) {
  const { pathname, search } = useLocation();
  const open = pathname === '/workspace' ? (search as { path?: string }).path : undefined;
  const back = useBackToComposer();
  return failedSetups
    .filter(({ path }) => path !== open)
    .map((failed) => (
      <div key={failed.id} className="flex shrink-0 flex-col items-start gap-1.5 px-2 py-1">
        <p className="text-xs break-words text-destructive">
          Could not create {failed.name}: {failed.message}
        </p>
        <Button variant="outline" className={buttonClass} onClick={() => void back(failed)}>
          Back to composer
        </Button>
      </div>
    ));
}
