import { rootRouteId, useLoaderData, useRouter } from '@tanstack/react-router';
import { FolderGit2Icon, FolderIcon, FolderOpenIcon, FolderPlusIcon, GitBranchIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { PageHeader } from '@/components/page-header';
import { nameProblem, repositoryName, tildePath } from '@/components/project-form';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { setProjectsMessage } from '@/components/workspace-panes';

// The dialog showing, if any. Module-level, like the Delete workspace dialog, so that the sidebar's menu, the
// empty state and ⌘O open the same ones and the sidebar may be hidden.
type Shown =
  | { kind: 'clone' }
  | { kind: 'create' }
  | { kind: 'init'; folder: string }
  | { kind: 'refusal'; title: string; message: string };

let shown: Shown | undefined;
const listeners = new Set<() => void>();

function show(next?: Shown) {
  shown = next;
  for (const listener of listeners) listener();
}

/** Opens the dialog of a refusal: one OK button. */
export const showRefusal = (title: string, message: string) => show({ kind: 'refusal', title, message });

/** The ways to add a project, shared by the Projects menu, the empty state and ⌘O. */
export function useAddProject() {
  const router = useRouter();
  /** A project was added: the sidebar lists it. */
  const listed = useCallback(async () => {
    setProjectsMessage(undefined);
    await router.invalidate();
  }, [router]);
  /** "Open project…": the folder picker, then the repository that holds the folder. */
  const open = useCallback(async () => {
    const result = await window.api.projects.add();
    if (result.status === 'added') await listed();
    else if (result.status === 'not-a-repository') show({ kind: 'init', folder: result.folder });
    else if (result.status === 'refused') showRefusal('Cannot add project', result.message);
  }, [listed]);
  return { open, listed, clone: () => show({ kind: 'clone' }), create: () => show({ kind: 'create' }) };
}

const DIALOGS = '[role="dialog"], [role="alertdialog"]';

/** The dialogs of adding a project, and the ⌘O shortcut that opens the folder picker while none is open. */
export function AddProject() {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => shown,
  );
  const { open } = useAddProject();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.key !== 'o') return;
      event.preventDefault();
      if (!document.querySelector(DIALOGS)) void open();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open]);
  if (!current) return null;
  const close = () => show(undefined);
  switch (current.kind) {
    case 'clone':
      return <CloneDialog onClose={close} />;
    case 'create':
      return <CreateDialog onClose={close} />;
    case 'init':
      return <InitDialog folder={current.folder} onClose={close} />;
    case 'refusal':
      return <RefusalDialog title={current.title} message={current.message} onClose={close} />;
  }
}

// --- The empty state ---------------------------------------------------------------------------------------------

function Card({ icon, title, line, onClick }: { icon: ReactNode; title: string; line: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-44 cursor-default flex-col items-start gap-3 rounded-lg border border-border bg-dialog p-3 text-left outline-none hover:bg-hover focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 [&_svg]:size-4 [&_svg]:stroke-[1.25] [&_svg]:text-muted-foreground"
    >
      {icon}
      <span className="flex flex-col gap-0.5">
        <span className="text-xs">{title}</span>
        <span className="text-[11px] text-muted-foreground">{line}</span>
      </span>
    </button>
  );
}

/** The home page when Cockpit has no project: how to add one. */
export function NoProjects() {
  const { open, clone, create } = useAddProject();
  return (
    <>
      <PageHeader />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-4 pt-4 pb-[60px]">
        <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-dialog">
          <FolderGit2Icon className="size-5 stroke-[1.5] text-muted-foreground" />
        </div>
        <div className="flex flex-col items-center gap-1.5 text-center">
          <h1 className="text-sm font-medium">No projects yet</h1>
          <p className="text-xs text-muted-foreground">Add a git repository to run agents in its workspaces.</p>
        </div>
        <div className="flex gap-2 pt-1">
          <Card icon={<FolderOpenIcon />} title="Open project" line="A repository on this Mac" onClick={() => void open()} />
          <Card icon={<GitBranchIcon />} title="Clone from Git" line="From a GitHub or GitLab URL" onClick={clone} />
          <Card icon={<FolderPlusIcon />} title="Create new" line="An empty git repository" onClick={create} />
        </div>
      </div>
    </>
  );
}

// --- Clone and Create ----------------------------------------------------------------------------------------------

// Where Clone and Create put the project: `~/projects` until "Choose…" picks another folder.
function useHome() {
  const [home, setHome] = useState<string>();
  useEffect(() => void window.api.projects.home().then(setHome), []);
  return home;
}

function usePlacement() {
  const home = useHome();
  const [picked, setPicked] = useState<string>();
  return {
    home,
    location: picked ?? (home === undefined ? undefined : `${home}/projects`),
    choose: async () => {
      const folder = await window.api.projects.pickFolder();
      if (folder !== null) setPicked(folder);
      return folder !== null;
    },
  };
}

function Field({ label, htmlFor, error, children }: { label: string; htmlFor?: string; error?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor} className="font-normal text-muted-foreground">
        {label}
      </Label>
      {children}
      {error && <p className="text-[11px] break-words text-destructive">{error}</p>}
    </div>
  );
}

// Aria-invalid keeps the destructive border in the dark theme too; no transition, so a read right after an error sees the final color.
const fieldClass = 'h-8 bg-background px-2.5 text-xs transition-none dark:bg-background dark:aria-invalid:border-destructive';

function LocationField({ shownPath, hint, disabled, onChoose }: { shownPath?: string; hint?: string; disabled: boolean; onChoose: () => void }) {
  return (
    <div className="grid gap-1.5">
      <span className="flex items-center text-xs/relaxed leading-none text-muted-foreground">Location</span>
      <div className="flex items-center gap-2">
        <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-xs">
          <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{shownPath}</span>
        </div>
        <Button type="button" variant="outline" disabled={disabled} onClick={onChoose} className="h-8 border-foreground/10 px-3">
          Choose…
        </Button>
      </div>
      {hint && <p className="text-[11px] break-words text-subtle">{hint}</p>}
    </div>
  );
}

// The providers' marks, from the Figma vectors: they take the tab's text color.
const Logo = ({ path }: { path: string }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true" className="shrink-0">
    <path d={path} />
  </svg>
);
const GITHUB = "M7 0.173248C3.1325 0.173248 0 3.3075 0 7.17325C0 10.2667 2.0055 12.8899 4.78625 13.8145C5.13625 13.8804 5.26458 13.664 5.26458 13.4779C5.26458 13.3117 5.25875 12.8712 5.25583 12.2879C3.30867 12.7102 2.898 11.3487 2.898 11.3487C2.5795 10.5408 2.11925 10.325 2.11925 10.325C1.48517 9.891 2.16825 9.89975 2.16825 9.89975C2.87117 9.94875 3.24042 10.6207 3.24042 10.6207C3.86458 11.6912 4.879 11.382 5.27917 11.2029C5.34217 10.7502 5.52242 10.4417 5.7225 10.2667C4.16792 10.0917 2.534 9.48967 2.534 6.8075C2.534 6.04333 2.80525 5.41916 3.25442 4.92916C3.17567 4.75241 2.93942 4.04075 3.31567 3.0765C3.31567 3.0765 3.90192 2.88866 5.24067 3.794C5.80067 3.63825 6.39567 3.56125 6.99067 3.55775C7.58567 3.56125 8.18067 3.63825 8.74067 3.794C10.0707 2.88866 10.6569 3.0765 10.6569 3.0765C11.0332 4.04075 10.7969 4.75241 10.7269 4.92916C11.1732 5.41916 11.4444 6.04333 11.4444 6.8075C11.4444 9.49667 9.80817 10.0887 8.25067 10.2608C8.49567 10.4708 8.72317 10.9002 8.72317 11.5558C8.72317 12.4927 8.71442 13.2452 8.71442 13.4727C8.71442 13.6564 8.83692 13.8752 9.19567 13.8052C11.9962 12.887 14 10.262 14 7.17325C14 3.3075 10.8657 0.173248 7 0.173248Z";
const GITLAB = "M13.7669 5.59574L13.7472 5.54546L11.8417 0.572482C11.8029 0.474986 11.7342 0.392278 11.6455 0.336232C11.5568 0.28117 11.4533 0.254661 11.349 0.260284C11.2447 0.265906 11.1447 0.30339 11.0624 0.367673C10.981 0.433792 10.9219 0.523393 10.8932 0.624282L9.60668 4.56062H4.39687L3.11022 0.624282C3.08231 0.522833 3.02311 0.432772 2.94105 0.366915C2.85873 0.302649 2.75868 0.265187 2.65439 0.259585C2.55011 0.253983 2.44662 0.280512 2.35789 0.33559C2.2694 0.391848 2.20081 0.474461 2.16177 0.571782L0.252699 5.54254L0.233741 5.59282C-0.0405727 6.30954 -0.0744372 7.09601 0.137254 7.83365C0.348944 8.57129 0.794714 9.22011 1.40735 9.68228L1.41394 9.68736L1.43144 9.69978L4.33411 11.8735L5.77027 12.9604L6.64498 13.6208C6.74731 13.6985 6.87225 13.7406 7.00073 13.7406C7.1292 13.7406 7.25415 13.6985 7.35647 13.6208L8.23118 12.9604L9.66729 11.8735L12.5875 9.68666L12.5947 9.68082C13.206 9.21856 13.6507 8.57041 13.8621 7.83377C14.0735 7.09712 14.0401 6.31177 13.7669 5.59574Z";

const dialogClass = 'w-[440px] max-w-none bg-dialog shadow-dialog transition-none sm:max-w-none';
const titleClass = 'text-[13px]';
const footerClass = 'flex-row justify-end gap-2 pt-1';
const cancelClass = 'border-foreground/10 px-3';
const primaryClass = 'bg-brand px-3 text-brand-foreground hover:bg-brand/90';
const tabClass =
  'h-7 flex-none gap-1.5 border-border pr-2.5 pl-2 font-normal text-muted-foreground data-active:border-transparent data-active:bg-sidebar-accent data-active:text-foreground';

function CloneDialog({ onClose }: { onClose: () => void }) {
  const { listed } = useAddProject();
  const { projects } = useLoaderData({ from: rootRouteId });
  const { home, location, choose } = usePlacement();
  const [provider, setProvider] = useState('github');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  // Once the user types a name, a later URL leaves it alone.
  const [named, setNamed] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [failure, setFailure] = useState<string>();
  const first = useRef<HTMLInputElement>(null);
  const ids = { url: useId(), name: useId() };

  const path = `${location}/${name}`;
  const problem = nameProblem(name);
  const known = location !== undefined && name !== '' && projects.some((project) => project.path === path);
  const canClone = url.trim() !== '' && name !== '' && problem === undefined && location !== undefined && !known && !cloning;

  async function clone() {
    if (!canClone || location === undefined) return;
    setCloning(true);
    setFailure(undefined);
    const result = await window.api.projects.clone({ url: url.trim(), location, name });
    setCloning(false);
    if (result.status === 'added') {
      onClose();
      await listed();
    } else if (result.status === 'refused') {
      setFailure(result.message);
    }
  }

  // Cancel and Escape: a running clone ends, and its partial folder goes with it.
  function cancel() {
    if (cloning) void window.api.projects.cancelClone();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && cancel()}>
      <DialogContent showCloseButton={false} initialFocus={first} className={dialogClass}>
        <DialogHeader>
          <DialogTitle className={titleClass}>Clone from Git</DialogTitle>
        </DialogHeader>
        <Tabs value={provider} onValueChange={setProvider}>
          <TabsList className="h-auto gap-1 bg-transparent p-0">
            <TabsTrigger value="github" disabled={cloning} className={tabClass}>
              <Logo path={GITHUB} />
              GitHub
            </TabsTrigger>
            <TabsTrigger value="gitlab" disabled={cloning} className={tabClass}>
              <Logo path={GITLAB} />
              GitLab
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Field label="Repository URL" htmlFor={ids.url} error={known ? `${name} is already in Cockpit.` : failure}>
          <Input
            id={ids.url}
            ref={first}
            value={url}
            disabled={cloning}
            placeholder={provider === 'github' ? 'https://github.com/owner/repository' : 'https://gitlab.com/group/project'}
            aria-invalid={known || failure !== undefined}
            className={fieldClass}
            onChange={(event) => {
              setUrl(event.target.value);
              if (!named) setName(repositoryName(event.target.value));
              setFailure(undefined);
            }}
          />
        </Field>
        <Field label="Project name" htmlFor={ids.name} error={problem}>
          <Input
            id={ids.name}
            value={name}
            disabled={cloning}
            aria-invalid={problem !== undefined}
            className={fieldClass}
            onChange={(event) => {
              setName(event.target.value);
              setNamed(true);
              setFailure(undefined);
            }}
          />
        </Field>
        <LocationField
          shownPath={location && home && tildePath(location, home)}
          hint={location && home && name !== '' && problem === undefined ? `Clones into ${tildePath(location, home)}/${name}` : undefined}
          disabled={cloning}
          onChoose={() => void choose().then((picked) => picked && setFailure(undefined))}
        />
        <DialogFooter className={footerClass}>
          <Button type="button" variant="outline" onClick={cancel} className={cancelClass}>
            Cancel
          </Button>
          <Button type="button" disabled={!canClone} onClick={() => void clone()} className={primaryClass}>
            {cloning ? 'Cloning…' : 'Clone'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const { listed } = useAddProject();
  const { home, location, choose } = usePlacement();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<string>();
  const first = useRef<HTMLInputElement>(null);
  const id = useId();

  const problem = nameProblem(name);
  const canCreate = name !== '' && problem === undefined && location !== undefined && !creating;

  async function create() {
    if (!canCreate || location === undefined) return;
    setCreating(true);
    setFailure(undefined);
    const result = await window.api.projects.create({ location, name });
    setCreating(false);
    if (result.status === 'added') {
      onClose();
      await listed();
    } else if (result.status === 'refused') {
      setFailure(result.message);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} initialFocus={first} className={dialogClass}>
        <DialogHeader>
          <DialogTitle className={titleClass}>Create new project</DialogTitle>
        </DialogHeader>
        <Field label="Project name" htmlFor={id} error={problem ?? failure}>
          <Input
            id={id}
            ref={first}
            value={name}
            disabled={creating}
            aria-invalid={problem !== undefined || failure !== undefined}
            className={fieldClass}
            onChange={(event) => {
              setName(event.target.value);
              setFailure(undefined);
            }}
          />
        </Field>
        <LocationField
          shownPath={location && home && tildePath(location, home)}
          hint={location && home && name !== '' && problem === undefined ? `Creates ${tildePath(location, home)}/${name} and runs git init` : undefined}
          disabled={creating}
          onChoose={() => void choose().then((picked) => picked && setFailure(undefined))}
        />
        <DialogFooter className={footerClass}>
          <Button type="button" variant="outline" onClick={onClose} className={cancelClass}>
            Cancel
          </Button>
          <Button type="button" disabled={!canCreate} onClick={() => void create()} className={primaryClass}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Open project: refusals ---------------------------------------------------------------------------------------------

function InitDialog({ folder, onClose }: { folder: string; onClose: () => void }) {
  const { listed } = useAddProject();
  const home = useHome();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  async function initialize() {
    setBusy(true);
    setFailure(undefined);
    const result = await window.api.projects.init(folder);
    setBusy(false);
    if (result.status === 'added') {
      onClose();
      await listed();
    } else if (result.status === 'refused') {
      setFailure(result.message);
    }
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader className="gap-1.5">
          <AlertDialogTitle>This folder is not a git repository</AlertDialogTitle>
          <AlertDialogDescription className="break-words">
            {home === undefined ? folder : tildePath(folder, home)} is not in a git repository. Cockpit can initialize one in this folder (git
            init) and add it as a project.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {failure && <p className="text-[11px] break-words text-destructive">{failure}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel className={cancelClass}>Cancel</AlertDialogCancel>
          <Button disabled={busy} onClick={() => void initialize()} className={primaryClass}>
            Initialize git repository
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RefusalDialog({ title, message, onClose }: { title: string; message: string; onClose: () => void }) {
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription className="break-words">{message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className={cancelClass}>OK</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
