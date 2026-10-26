"use client"

import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Forge's buttons (task #228): pills with a gentle 140deg sheen and no shadow
// (Forge's flat-buttons rule, idea #121). Brand blue for the main action, white for
// the rest, red for a confirmed delete. A press dims and gives a little.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-full border border-transparent bg-clip-padding font-semibold whitespace-nowrap transition-[filter,scale,background-color,color,border-color,box-shadow] duration-150 outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/35 active:not-disabled:scale-[0.985] active:not-disabled:brightness-94 disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary bg-(image:--tex-brand) text-primary-foreground hover:brightness-106",
        outline:
          "border-border bg-card bg-(image:--tex-white) text-foreground hover:brightness-[0.975] aria-expanded:brightness-[0.97]",
        secondary:
          "border-border bg-card bg-(image:--tex-white) text-foreground hover:brightness-[0.975] aria-expanded:brightness-[0.97]",
        ghost:
          "text-foreground/80 hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        destructive:
          "bg-destructive bg-(image:--tex-danger) text-white hover:brightness-105 focus-visible:ring-destructive/30",
        link: "rounded-md text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-[38px] gap-[7px] px-4 text-[13.5px] has-data-[icon=inline-end]:pr-3.5 has-data-[icon=inline-start]:pl-3.5",
        xs: "h-[26px] gap-[5px] px-[11px] text-[11.5px] pointer-coarse:h-8 pointer-coarse:px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-[30px] gap-1.5 px-3 text-[12.5px] has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-[42px] gap-2 px-5 text-sm has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        icon: "size-9",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
