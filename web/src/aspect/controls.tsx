// Aspect UI v0.2.0 registry controls used in Caudal.
import type { ComponentProps, ReactNode } from "react";
import { Button as SdkButton } from "@ui-sdk/react/button";
import {
  Dialog as SdkDialog, DialogBackdrop, DialogClose, DialogContent,
  DialogDescription, DialogTitle,
} from "@ui-sdk/react/dialog";
import { Input as SdkInput } from "@ui-sdk/react/input";
import { Textarea as SdkTextarea } from "@ui-sdk/react/textarea";

function withClass(base: string, className?: string) {
  return className ? base + " " + className : base;
}

export function Button({
  variant = "secondary", className, type = "button", onClick, ...props
}: Omit<ComponentProps<typeof SdkButton>, "className"> & {
  className?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return <SdkButton {...props} type={type} className={withClass("aspect-button", className)}
    data-variant={variant} onClick={onClick && ((event, details) => {
      if (props["aria-haspopup"] === "dialog") event.currentTarget.focus({ preventScroll: true });
      return onClick(event, details);
    })} />;
}

export function Input({ className, ...props }: Omit<ComponentProps<typeof SdkInput>, "className"> & { className?: string }) {
  return <SdkInput {...props} className={withClass("aspect-input", className)} />;
}

export function Textarea({ className, ...props }: Omit<ComponentProps<typeof SdkTextarea>, "className"> & { className?: string }) {
  return <SdkTextarea {...props} className={withClass("aspect-input", className)} />;
}

export function Badge({
  tone = "neutral", className, ...props
}: ComponentProps<"span"> & { tone?: "neutral" | "accent" | "success" | "warning" | "danger" }) {
  return <span {...props} className={withClass("aspect-badge", className)} data-tone={tone} />;
}

export function Dialog({
  open, onClose, title, description, children, closeLabel = "Close dialog",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  closeLabel?: string;
  children: ReactNode;
}) {
  return <SdkDialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogBackdrop className="aspect-dialog-backdrop" />
    <DialogContent inline className="aspect-dialog">
      <div className="aspect-dialog-heading">
        <DialogTitle>{title}</DialogTitle>
        <DialogClose className="aspect-button" data-variant="ghost" aria-label={closeLabel}>×</DialogClose>
      </div>
      {description && <DialogDescription className="aspect-dialog-description">{description}</DialogDescription>}
      {children}
    </DialogContent>
  </SdkDialog>;
}
