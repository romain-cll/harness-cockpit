import { rootRouteId, useLoaderData, useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { ArrowUpIcon, ChevronDownIcon, GitBranchIcon, LoaderCircleIcon, RefreshCwIcon } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent } from 'react';
import type { AvailableHarness, BranchesResult, Project } from '../../shared/api';
import { startSession } from '@/components/live-terminals';
import { PageHeader } from '@/components/page-header';
import { ProjectBadge } from '@/components/project-badge';
import { detectHarnesses, useDetectedHarnesses } from '@/components/start-session-menu';
import { Button } from '@/components/ui/button';
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
} from '@/components/ui/combobox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InputGroupTextarea } from '@/components/ui/input-group';
import { addSessionTab, openShellTab } from '@/components/workspace-panes';

// The pseudo-harness of "Terminal": no agent CLI. In a workspace it is the setup shell tab; with no project, a session running the login shell.
const TERMINAL = 'terminal';

const selectClass = 'h-6 gap-1 px-2 font-normal';
const mutedClass = 'text-muted-foreground!';
const menuClass = 'w-auto min-w-56';

/** The agent CLIs found on this machine, from the store the menus share; `undefined` while they are being detected. */
function useHarnesses() {
  const detected = useDetectedHarnesses();
  const [again, setAgain] = useState(false);
  useEffect(() => void detectHarnesses(), []);
  const detectAgain = () => {
    setAgain(true);
    void detectHarnesses(true).finally(() => setAgain(false));
  };
  return { harnesses: again ? undefined : detected, detectAgain };
}

function AgentSelect({
  harnesses,
  agent,
  onChange,
  onDetectAgain,
}: {
  harnesses?: AvailableHarness[];
  agent?: string;
  onChange: (agent: string) => void;
  onDetectAgain: () => void;
}) {
  const name = harnesses?.find(({ id }) => id === agent)?.name ?? 'Terminal';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className={selectClass} />}>
        {harnesses === undefined ? (
          <>
            <LoaderCircleIcon className="animate-spin" />
            Detecting…
          </>
        ) : (
          name
        )}
        <ChevronDownIcon className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={menuClass}>
        {harnesses === undefined ? (
          <DropdownMenuItem disabled>Detecting agent CLIs…</DropdownMenuItem>
        ) : (
          <>
            {harnesses.length === 0 && (
              <DropdownMenuItem disabled className="flex-col items-start gap-0">
                <span>No agent CLI found</span>
                <span className={`${mutedClass} max-w-64 whitespace-normal`}>
                  Install Claude Code, Codex or OpenCode, then detect again. Until then, the workspace opens with a terminal.
                </span>
              </DropdownMenuItem>
            )}
            <DropdownMenuRadioGroup value={agent} onValueChange={onChange}>
              {[...harnesses, { id: TERMINAL, name: 'Terminal', version: null }].map((harness) => (
                <DropdownMenuRadioItem
                  key={harness.id}
                  value={harness.id}
                  closeOnClick
                  className="pr-2 pl-7 [&>[data-slot=dropdown-menu-radio-item-indicator]]:right-auto [&>[data-slot=dropdown-menu-radio-item-indicator]]:left-2"
                >
                  {harness.name}
                  {harness.version && <span className={`${mutedClass} ml-auto pl-4`}>{harness.version}</span>}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDetectAgain}>
              <RefreshCwIcon />
              Detect again
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BaseSelect({ branches, base, onChange }: { branches?: BranchesResult; base: string | null; onChange: (base: string) => void }) {
  const listed = branches?.status === 'listed' ? branches : undefined;
  const groups = [
    { value: 'Local', items: listed?.local ?? [] },
    { value: 'Remote', items: listed?.remote ?? [] },
  ].filter((group) => group.items.length > 0);
  return (
    <Combobox items={groups} value={base} onValueChange={(value) => value && onChange(value)}>
      <ComboboxTrigger render={<Button variant="ghost" size="sm" className={selectClass} />}>
        <GitBranchIcon />
        {base ?? 'Select a base'}
      </ComboboxTrigger>
      <ComboboxContent className="w-64">
        <ComboboxInput placeholder="Search branches" showTrigger={false} />
        <ComboboxEmpty>No branch found</ComboboxEmpty>
        <ComboboxList>
          {(group: (typeof groups)[number]) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.value}</ComboboxLabel>
              <ComboboxCollection>
                {(branch: string) => (
                  <ComboboxItem key={branch} value={branch}>
                    {branch}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function ProjectSelect({ projects, project }: { projects: Project[]; project?: Project }) {
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className={selectClass} />}>
        {project ? (
          <>
            <ProjectBadge path={project.path} name={project.name} />
            {project.name}
          </>
        ) : (
          'No project'
        )}
        <ChevronDownIcon className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={menuClass}>
        <DropdownMenuRadioGroup
          value={project?.path ?? 'none'}
          onValueChange={(value) => void navigate({ to: '/', search: { project: value }, replace: true })}
        >
          {projects.map((each) => (
            <DropdownMenuRadioItem key={each.path} value={each.path} closeOnClick>
              <ProjectBadge path={each.path} name={each.name} />
              {each.name}
            </DropdownMenuRadioItem>
          ))}
          {projects.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuRadioItem value="none" closeOnClick className="flex-col items-start gap-0">
            <span>No project</span>
            <span className={mutedClass}>Runs in its own folder</span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The home page: describe a task, pick the project, the agent and the base, send. A send makes the
 * workspace (a worktree on a branch named after the task) and opens its page: the agent runs there on the
 * prompt after the workspace's setup, or "Terminal" shows the setup, then the login shell. With no project
 * the session's own page opens.
 */
export function NewWorkspace() {
  const router = useRouter();
  const navigate = useNavigate();
  const { projects } = useLoaderData({ from: rootRouteId });
  const requested = useSearch({ from: '/', select: (search) => search.project });
  // `?project=none` is no project; a missing or unknown path is the first project of the sidebar.
  const project = requested === 'none' ? undefined : (projects.find(({ path }) => path === requested) ?? projects[0]);
  const { harnesses, detectAgain } = useHarnesses();
  const [choice, setChoice] = useState<string>();
  const [prompt, setPrompt] = useState('');
  // The branches of a project, and the base picked for it; both belong to the path they were read for.
  const [read, setRead] = useState<{ path: string; branches: BranchesResult }>();
  const [picked, setPicked] = useState<{ path: string; base: string }>();
  const [sending, setSending] = useState(false);
  // Why the last send was refused, cleared by the next one that succeeds.
  const [message, setMessage] = useState<string>();

  const path = project?.path;
  useEffect(() => {
    if (path === undefined) return;
    let current = true;
    void window.api.workspaces.branches(path).then((branches) => current && setRead({ path, branches }));
    return () => {
      current = false;
    };
  }, [path]);
  const branches = read && read.path === path ? read.branches : undefined;
  // The picked base, else the project's default one; `null` until one is known.
  const base = picked && picked.path === path ? picked.base : branches?.status === 'listed' ? branches.defaultBase : null;

  // The chosen agent while it is still detected, else the first detected one, else the terminal.
  const agent =
    harnesses === undefined
      ? undefined
      : choice === TERMINAL || harnesses.some(({ id }) => id === choice)
        ? choice
        : (harnesses[0]?.id ?? TERMINAL);
  const task = prompt.trim();
  const canSend = task !== '' && agent !== undefined && (project === undefined || (branches?.status === 'listed' && base !== null)) && !sending;

  async function send() {
    if (!canSend || agent === undefined) return;
    setSending(true);
    try {
      const withAgent = agent !== TERMINAL;
      if (project && base !== null) {
        const created = await window.api.workspaces.create(project.path, task, base);
        if (created.status === 'refused') {
          setMessage(created.message);
          return;
        }
        const workspace = created.workspace.path;
        // The sidebar lists the workspace, whether or not its session starts.
        await router.invalidate();
        if (withAgent) {
          const started = await startSession(agent, {
            workspace: { project: project.path, path: workspace },
            setup: true,
            prompt: task,
            nameFromTitle: true,
          });
          if (started.status === 'refused') {
            setMessage(started.message);
            return;
          }
          addSessionTab(started.session);
        } else {
          // "Terminal" is the workspace's setup shell tab, no session.
          openShellTab(workspace, { setup: true });
        }
        setMessage(undefined);
        await router.invalidate();
        await navigate({ to: '/workspace', search: { path: workspace } });
        return;
      }
      const started = await startSession(agent, withAgent ? { prompt: task } : undefined);
      if (started.status === 'refused') {
        setMessage(started.message);
        return;
      }
      setMessage(undefined);
      await router.invalidate();
      await navigate({ to: '/sessions/$sessionId', params: { sessionId: started.session.id } });
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  }

  const problem = message ?? (branches?.status === 'refused' ? branches.message : undefined);

  return (
    <>
      <PageHeader />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
        <h1 className="text-xs text-muted-foreground">New workspace</h1>
        <form
          className="flex w-[600px] max-w-full flex-col gap-3 rounded-xl border border-border bg-hover pt-3 pr-2.5 pb-2.5 pl-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <InputGroupTextarea
            aria-label="Prompt"
            placeholder="Describe the task"
            rows={2}
            value={prompt}
            autoFocus
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={onKeyDown}
            className="min-h-10 p-0 text-[13px] focus-visible:border-0 md:text-[13px]"
          />
          <div className="flex items-center gap-1.5">
            <ProjectSelect projects={projects} project={project} />
            <AgentSelect harnesses={harnesses} agent={agent} onChange={setChoice} onDetectAgain={detectAgain} />
            {project && <BaseSelect branches={branches} base={base} onChange={(next) => path !== undefined && setPicked({ path, base: next })} />}
            <Button
              type="submit"
              size="icon"
              aria-label="Create workspace"
              disabled={!canSend}
              className="ml-auto size-[26px] rounded-full bg-brand text-brand-foreground hover:bg-brand/90"
            >
              <ArrowUpIcon />
            </Button>
          </div>
        </form>
        {problem && (
          <p role="status" className="w-[600px] max-w-full text-xs break-words text-destructive">
            {problem}
          </p>
        )}
      </div>
    </>
  );
}
