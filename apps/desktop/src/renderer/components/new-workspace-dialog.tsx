import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { BranchesResult, Project } from '../../shared/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';

export function NewWorkspaceDialog({
  project,
  onClose,
  onCreated,
}: {
  project: Project;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [branches, setBranches] = useState<BranchesResult>();
  const [name, setName] = useState('');
  const [base, setBase] = useState<string | null>(null);
  // Why the branches could not be listed, or the last creation was refused.
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let current = true;
    void window.api.workspaces.branches(project.path).then((result) => {
      if (!current) return;
      setBranches(result);
      if (result.status === 'listed') setBase(result.defaultBase);
      else setMessage(result.message);
    });
    return () => {
      current = false;
    };
  }, [project.path]);

  const canCreate = branches?.status === 'listed' && base !== null && name.trim() !== '' && !busy;

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!canCreate) return;
    setBusy(true);
    try {
      const result = await window.api.workspaces.create(project.path, name.trim(), base);
      if (result.status === 'refused') setMessage(result.message);
      else await onCreated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent initialFocus={nameField}>
        <DialogHeader>
          <DialogTitle>New workspace in {project.name}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(event) => void create(event)}>
          <div className="grid gap-2">
            <Label htmlFor="workspace-name">Name</Label>
            <Input id="workspace-name" ref={nameField} value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="workspace-base">Base</Label>
            <Select value={base} onValueChange={setBase}>
              <SelectTrigger id="workspace-base" className="w-full">
                <SelectValue placeholder="Select a base" />
              </SelectTrigger>
              <SelectContent>
                {branches?.status === 'listed' && branches.local.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Local</SelectLabel>
                    {branches.local.map((branch) => (
                      <SelectItem key={branch} value={branch}>
                        {branch}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {branches?.status === 'listed' && branches.remote.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Remote</SelectLabel>
                    {branches.remote.map((branch) => (
                      <SelectItem key={branch} value={branch}>
                        {branch}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
          </div>
          {message && (
            <p role="status" className="text-xs break-words text-destructive">
              {message}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={!canCreate}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
