import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "cn"

// Sized to the Figma frame (34:2610, 34:3100): a 28 × 16 track and a 12 px knob, on `brand` with a white knob at the
// right, off on `sidebar-accent` with a `muted-foreground` knob at the left. No transition: a color read right after a
// change is the final one.
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-transparent outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 data-checked:bg-brand data-unchecked:bg-sidebar-accent data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-3 rounded-full ring-0 data-checked:translate-x-3.5 data-checked:bg-brand-foreground data-unchecked:translate-x-0 data-unchecked:bg-muted-foreground"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
