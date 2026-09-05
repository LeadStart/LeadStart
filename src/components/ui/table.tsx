"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { cn } from "@/lib/utils"
import { appUrl } from "@/lib/api-url"

// Descendants that own their own click and must NOT trigger a clickable row's
// navigation (links elsewhere, buttons, menus, form controls). Put
// data-row-click-ignore on anything else that should stay independent.
const ROW_INTERACTIVE_SELECTOR =
  'a,button,input,select,textarea,label,[role="button"],[role="menuitem"],[role="menu"],[role="checkbox"],[role="switch"],[data-row-click-ignore]'

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({
  className,
  href,
  onClick,
  ...props
}: React.ComponentProps<"tr"> & { href?: string }) {
  const router = useRouter()

  if (!href) {
    return (
      <tr
        data-slot="table-row"
        className={cn(
          "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
          className
        )}
        onClick={onClick}
        {...props}
      />
    )
  }

  // Whole-row navigation: a click anywhere in the row (except on a genuinely-
  // interactive descendant) opens `href`, so the entire row behaves like its
  // primary link. The row keeps its real inner <Link> as the keyboard/AT anchor
  // this is a pointer-only convenience on top. Modifier / middle click opens a
  // new tab, at parity with a real link (window.open bypasses the router, so it
  // needs the basePath that appUrl adds).
  const fromInteractive = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest(ROW_INTERACTIVE_SELECTOR)

  const handleClick = (e: React.MouseEvent<HTMLTableRowElement>) => {
    onClick?.(e)
    if (e.defaultPrevented || fromInteractive(e.target)) return
    if (e.metaKey || e.ctrlKey) {
      window.open(appUrl(href), "_blank", "noopener")
      return
    }
    router.push(href)
  }

  const handleAuxClick = (e: React.MouseEvent<HTMLTableRowElement>) => {
    if (e.button !== 1 || fromInteractive(e.target)) return
    e.preventDefault()
    window.open(appUrl(href), "_blank", "noopener")
  }

  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted cursor-pointer",
        className
      )}
      onClick={handleClick}
      onAuxClick={handleAuxClick}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
