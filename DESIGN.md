# Design System

## 1. Direction

This is an internal buyer-intelligence console. The UI should stay quiet, operational, and scan-friendly: pale blue-gray page washes, white tool surfaces, teal primary actions, indigo debug affordances, and compact cards for repeated choices or event rows.

## 2. Color

- Page wash: `from-[#f0f4f8] to-[#e8edf2]`.
- Primary action: teal `600`, hover teal `700`, accent teal `50`/`100`.
- Debug action: indigo `600`, hover indigo `700`.
- Text: gray `900` for page titles, gray `800` for card titles, gray `500`/`600` for body, gray `400` for metadata.
- Surfaces: white cards with gray `200` borders; debug surfaces use purple `50` with purple `200` borders.
- Status: amber for processing, teal/green for partial/complete, red for failures.

## 3. Typography

- Use the existing Tailwind/system font stack.
- Page title: `text-4xl sm:text-5xl font-extrabold`.
- Section title: `text-lg font-bold`.
- Card title: `text-sm font-bold`.
- Metadata: `text-[10px]` to `text-[12px]`, uppercase when it acts as a label.

## 4. Spacing

- Page shell: `min-h-screen`, centered column, `px-4 py-16`.
- Intro column: `max-w-xl`, `space-y-6`.
- Tool panels: `rounded-2xl`, `p-4` to `p-5`, `gap-3`.
- Repeated grids: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`, `gap-3`.

## 5. Primitives

- Icon block: `w-16 h-16 rounded-2xl bg-teal-500 shadow-lg`, with one lucide icon.
- Primary button: teal filled, `rounded-2xl`, semibold, color transition.
- Secondary card button: white surface, gray border, hover teal border, subtle lift and shadow.
- Form input: rounded-xl border, compact padding, focus ring matching the local accent.
- Event row: compact white card with source, status chip, timestamp, and a scrollable JSON preview.

## 6. Motion

Use only meaningful interaction motion already present in the app: hover color, small card lift, modal/page entrance, and reduced-motion overrides from `src/index.css`.

## 7. Accessibility

Buttons must be real `button` elements. Inputs need visible labels. Status/event lists should expose changes through ordinary rendered text; avoid icon-only state with no label.

