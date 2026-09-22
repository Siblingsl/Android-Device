# Device detail control layout

## Request

On the device detail control page, the device preview must occupy its own full-width row and remain collapsible. The remaining control modules must flow in symmetric two-column rows, with equal heights within each row. At narrow widths the layout may collapse to one column.

## Goals

- Keep the preview visually independent from the action modules.
- Reuse the existing disclosure behavior so preview content can be collapsed and expanded.
- Make the media, input, device-control, and terminal shelves form an equal-width two-column grid.
- Stretch both shelves in each grid row to the same height.
- Preserve the existing handlers and device-control behavior.

## Non-goals

- No backend or device protocol changes.
- No changes to preview interactions, scrcpy actions, or shelf contents.

## Acceptance

- Preview is a full-width collapsible row above the action grid.
- Action shelves appear left-to-right, then continue on the next row.
- Wide layouts use equal columns and equal-height items per row.
- Narrow layouts remain usable by switching to one column.
