import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useSyncExternalStore } from 'react';
import { PageHeader } from '@/components/page-header';
import { Terminal } from '@/components/terminal';
import { Button } from '@/components/ui/button';
import { getSetup, retrySetup, startAnyway, subscribe } from '@/components/workspace-setups';

export const Route = createFileRoute('/setup')({
  validateSearch: (search: Record<string, unknown>) => ({ path: typeof search.path === 'string' ? search.path : '' }),
  component: SetupPage,
});

function SetupPage() {
  const { path } = Route.useSearch();
  const router = useRouter();
  const setup = useSyncExternalStore(subscribe, () => getSetup(path));

  if (!setup) {
    return (
      <>
        <PageHeader title="Setup" />
        <p className="p-4 text-sm">No setup ran for this workspace in this window.</p>
      </>
    );
  }

  const status = setup.status === 'done' ? 'Setup finished' : setup.failure;
  return (
    <>
      <PageHeader title={`Setup of ${setup.workspace.name}`} />
      {setup.terminal && (
        <div className="min-h-0 flex-1">
          <Terminal live={setup.terminal} focused />
        </div>
      )}
      {(status || setup.sessionRefusal) && (
        <div className="flex shrink-0 flex-col gap-2 border-t p-4 text-sm">
          {status && <p className="break-words">{status}</p>}
          {setup.sessionRefusal && <p className="break-words text-destructive">{setup.sessionRefusal}</p>}
          {setup.status === 'failed' && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => void retrySetup(router, path)}>
                Retry setup
              </Button>
              {setup.agent && (
                <Button variant="outline" size="sm" onClick={() => void startAnyway(router, path)}>
                  Start anyway
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
