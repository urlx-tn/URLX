# URLX V1 Frontend Astro UI Plan

## Purpose

This plan covers only the frontend work for URLX v1.

The frontend is responsible for:

- Presenting a clean public URL shortener interface.
- Letting a user submit one long URL.
- Calling the backend oRPC `links.shorten` procedure.
- Showing the generated short URL.
- Letting the user copy the short URL.
- Generating a QR code for the short URL in the browser.
- Handling loading, success, copy, QR, and error states.

This plan does not cover database schema, redirect implementation, backend validation internals, Cloudflare D1, or server infrastructure except where the frontend must consume a backend contract.

## Active Stack

```text
Framework: Astro
Runtime target: Cloudflare Astro Worker
API client: oRPC client
Styling: Tailwind CSS v4 plus focused custom CSS
Package manager: pnpm
Linting/formatting: Biome
```

Do not add:

```text
React
Vue
Svelte
client-side app framework
heavy UI library
animation library
large state manager
marketing-page framework
gradient/background generator
```

Astro with small, targeted browser scripts is enough for v1.

## Existing Repo Ownership

Frontend code lives in:

```text
apps/web
```

Expected files:

```text
apps/web/
  src/
    pages/
      index.astro
    layouts/
      Layout.astro
    components/
      Header.astro
      UrlShortenerForm.astro
      ResultPanel.astro
      QrCodePanel.astro
    lib/
      orpc.ts
      copy-to-clipboard.ts
      qr-code.ts
      form-errors.ts
    styles/
      global.css
      tokens.css
```

Use the current `apps/web/src/lib/orpc.ts` client pattern. The browser should call:

```text
orpc.links.shorten({ url })
```

through:

```text
${PUBLIC_SERVER_URL}/rpc
```

## Product Scope

The first screen is the product. Do not create a marketing landing page before the tool.

Required user actions:

1. Paste a long URL.
2. Click `Shorten URL`.
3. See one generated short URL.
4. Copy the generated short URL.
5. Generate a QR code for the generated short URL.
6. Open the short URL externally and be redirected by the backend.

Not included:

```text
login
account creation
dashboard
analytics
custom aliases
custom domains
link history
payments
admin panel
mobile app
browser extension
```

## Visual Direction

Think Apple-like: quiet, precise, confident, and useful.

The interface should feel:

- Minimal.
- Premium.
- Calm.
- Fast.
- Trustworthy.
- Purpose-built.

Hard rules:

- No AI-slop composition.
- No gradients.
- No glowing effects.
- No neon accents.
- No flashy effects.
- No decorative blobs, orbs, bokeh, or abstract background shapes.
- No oversized marketing hero that delays the actual tool.
- No split hero with decorative illustration.
- No overuse of cards.
- No nested cards.
- No heavy shadows.
- No noisy icon clutter.
- No stock-photo feeling.
- No animation library.
- No generic SaaS dashboard chrome.

The UI should look like a polished utility, not a generated template.

## First Viewport Composition

The first viewport should include the actual shortener.

Recommended structure:

```text
Header
  URLX wordmark
  Short trust line or status text

Main
  Title
  Subtitle
  URL input and submit button
  Result area that appears after success

Footer line
  Small privacy/trust note
```

The user should not need to scroll to use the product on desktop or mobile.

Avoid adding feature grids, testimonials, stats, pricing, or marketing sections in v1.

## Layout System

Use a centered, restrained layout:

```text
max-width: 720px to 880px for primary content
generous top spacing
single-column structure
clear vertical rhythm
compact header
small footer
```

Desktop:

- Header at top with subtle spacing.
- Main tool centered horizontally.
- Title and subtitle above the input.
- Result appears below the form without shifting the entire page dramatically.

Mobile:

- Single column.
- Input and button can stack if needed.
- Touch targets must be at least 44px tall.
- Long URLs and short URLs must wrap or truncate cleanly.
- No horizontal overflow.

## Card Usage

Cards are allowed only when they frame functional state.

Allowed:

- One form surface if it improves clarity.
- One result surface after a short link is generated.
- One QR code area inside the result state.

Avoid:

- Card inside card.
- Multiple decorative cards.
- Feature cards.
- Floating page-section cards.
- Marketing tiles.

Preferred style:

```text
border: 1px solid subtle neutral
radius: 8px or less
background: solid neutral
shadow: none or extremely subtle
```

## Color System

Use a neutral, professional palette.

Recommended light mode:

```text
page background: near white
surface: white
primary text: near black
secondary text: cool gray
border: light gray
button: near black
button text: white
focus ring: clean blue or graphite outline
success: restrained green
error: restrained red
```

Recommended dark mode, if retained:

```text
page background: near black
surface: very dark neutral
primary text: white
secondary text: neutral gray
border: dark neutral
button: white
button text: black
focus ring: clean blue or white outline
success: restrained green
error: restrained red
```

Avoid one-note palettes:

- Do not make the page all purple.
- Do not make the page all blue.
- Do not use beige or tan as the dominant identity.
- Do not use brown, orange, or espresso as the dominant identity.
- Do not use a gradient to create visual interest.

Visual interest should come from spacing, typography, alignment, and precise interaction states.

## Typography

Use system UI or a high-quality sans font already available in the project.

Guidelines:

- Title should be confident but not gigantic.
- Subtitle should be short and calm.
- Form text should be easy to scan.
- Button labels should not wrap awkwardly.
- Do not scale font size with viewport width.
- Do not use negative letter spacing.
- Keep letter spacing at 0 unless the existing design system already requires otherwise.

Suggested sizes:

```text
Header wordmark: 18px to 22px
Title: 40px to 56px desktop, 32px to 40px mobile
Subtitle: 16px to 18px
Input: 16px
Button: 15px to 16px
Helper/error text: 13px to 14px
```

## Copy

Use concise, product-first copy.

Header:

```text
URLX
Clean links, instantly.
```

Title:

```text
Shorten links. Share them beautifully.
```

Subtitle:

```text
Create clean, reliable short links in seconds.
```

Input placeholder:

```text
Paste your long URL
```

Primary button:

```text
Shorten URL
```

Loading button:

```text
Shortening...
```

Result label:

```text
Your short link
```

Copy button:

```text
Copy
Copied
```

QR button:

```text
Generate QR code
```

Footer trust note:

```text
No sign-up required. No destination fetching.
```

Do not add visible instructions explaining every feature. The interface should be self-evident.

## Component Plan

### `Header.astro`

Responsibilities:

- Show URLX wordmark.
- Show one short trust/status line.
- Stay compact.

Avoid:

- Large nav.
- Auth buttons.
- Marketing links.
- Social icons.

### `UrlShortenerForm.astro`

Responsibilities:

- Render URL input.
- Render submit button.
- Expose DOM hooks for the small browser script.
- Show inline error text.
- Show loading state.

States:

```text
idle
focused
submitting
error
success
```

Input behavior:

- Trim user input before submit.
- Let the backend be the final validator.
- Optionally do light client validation for empty string and obvious non-URL text.
- Preserve the submitted value on error so the user can edit it.

### `ResultPanel.astro`

Responsibilities:

- Show the generated short URL.
- Provide copy button.
- Provide QR button.
- Reserve enough space so appearing controls do not jolt the layout.

Behavior:

- Short URL should be selectable.
- Long short-link text should wrap or truncate with accessible full text.
- Copy should use `navigator.clipboard` when available.
- Provide a fallback copy method only if it stays small.

### `QrCodePanel.astro`

Responsibilities:

- Generate QR code client-side after user clicks.
- Encode the short URL, not the original URL.
- Keep QR rendering visually calm.
- Provide alt/label text for accessibility.

Behavior:

- Lazy-load QR code logic only after success or on QR click.
- Do not store QR code in the database.
- Do not upload QR code anywhere.
- QR should appear below the result controls.

## Browser Script Plan

Use one small script attached to the page or component.

State shape:

```ts
type ShortenerState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; shortCode: string; shortUrl: string }
  | { status: "error"; code: string; message: string };
```

Submit flow:

```text
User submits form
Disable input and button
Call orpc.links.shorten({ url })
If success, render shortUrl and actions
If error, render friendly message
Always restore usable controls
```

Copy flow:

```text
User clicks Copy
Write shortUrl to clipboard
Change label to Copied
After short delay, restore Copy
```

QR flow:

```text
User clicks Generate QR code
Lazy-load QR module
Generate QR from shortUrl
Fade in QR area subtly
```

## Error Handling

Frontend should map backend error codes to friendly messages.

Messages:

```text
EMPTY_URL: Please enter a URL.
INVALID_URL: Please enter a valid http or https URL.
UNSUPPORTED_PROTOCOL: Please enter a valid http or https URL.
LOCAL_URL_NOT_ALLOWED: Local URLs cannot be shortened.
PRIVATE_IP_NOT_ALLOWED: Private network URLs cannot be shortened.
URL_TOO_LONG: This URL is too long.
RATE_LIMITED: Too many requests. Please try again shortly.
SERVER_ERROR: Something went wrong. Please try again.
```

Network failure:

```text
Something went wrong. Please try again.
```

Do not show:

```text
stack traces
raw oRPC internals
Cloudflare errors
database errors
debug JSON
```

## Micro-Interactions

Use subtle, fast, functional motion only.

Allowed:

- Button loading text change.
- Spinner or small progress indicator if it is quiet.
- Input border/focus transition.
- Copy button label changes to `Copied`.
- Result area fades in or slides a few pixels.
- QR code fades in.
- Error text fades in.

Timing:

```text
120ms to 180ms for focus and button transitions
160ms to 220ms for result and QR appearance
```

Motion rules:

- Use CSS transitions.
- Respect `prefers-reduced-motion`.
- No springy animations.
- No bounce.
- No parallax.
- No scroll-triggered effects.
- No animated backgrounds.
- No glowing hover states.

Reduced motion:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
  }
}
```

## Accessibility

Requirements:

- Use a real `<form>`.
- Use a real `<label>` for the URL input. It may be visually refined, but it must exist.
- Use `type="url"` only if it does not fight the backend validation UX.
- Associate error text with the input using `aria-describedby`.
- Use `aria-live="polite"` for result and copy state.
- Use `aria-live="assertive"` or focused error handling for submit errors.
- Ensure keyboard-only operation works.
- Ensure focus states are visible.
- Ensure color contrast is AA or better.
- Do not rely on color alone for errors or success.
- Keep QR code label accessible.

Keyboard behavior:

```text
Enter submits the form.
Tab order follows visual order.
Copy button is reachable.
Generate QR button is reachable.
Focus does not jump unexpectedly on success.
```

## Responsive Requirements

Desktop:

- Input and button may sit on one row.
- Result URL can sit beside copy controls if space allows.
- Content should not feel stretched on wide screens.

Tablet:

- Keep primary content centered.
- Maintain comfortable spacing.

Mobile:

- Stack input and button if needed.
- Avoid tiny text.
- Avoid cramped side padding.
- Keep touch targets at least 44px.
- Ensure copied short link does not overflow.
- QR code should scale to fit viewport.

Recommended sizing:

```text
page horizontal padding: 20px mobile, 32px desktop
primary content max width: 760px
form control height: 48px to 56px
border radius: 8px or less
```

## QR Code Requirements

Generate QR in the frontend after the backend returns `shortUrl`.

Encode:

```text
shortUrl
```

Do not encode:

```text
original URL
```

Implementation options:

- Use a lightweight QR package only if needed.
- Lazy-load QR code logic.
- Render to canvas or SVG.
- Keep the output crisp on high-density screens.

Do not:

- Store QR codes.
- Upload QR codes.
- Generate QR codes on the server.
- Add QR customization in v1.
- Add QR downloads in v1 unless explicitly requested later.

## Performance Requirements

Frontend should remain lightweight.

Requirements:

- Keep JavaScript minimal.
- Avoid a client-side framework.
- Lazy-load QR code code path.
- Avoid heavy icon libraries unless already used.
- Avoid large images.
- Avoid animation libraries.
- Avoid page-level hydration.
- Keep CSS small and predictable.

The page should remain useful even on slow connections:

- Form appears quickly.
- Loading state is obvious.
- Network errors are recoverable.

## Implementation Order

1. Remove generated demo/status content from `apps/web/src/pages/index.astro`.
2. Keep or simplify `Layout.astro` for metadata and global shell.
3. Refine `Header.astro` into a compact URLX header.
4. Add design tokens in `tokens.css` if needed.
5. Update `global.css` with restrained base styles.
6. Create `UrlShortenerForm.astro`.
7. Create `ResultPanel.astro`.
8. Create `QrCodePanel.astro`.
9. Add `copy-to-clipboard.ts`.
10. Add `qr-code.ts` with lazy-load-friendly API.
11. Add `form-errors.ts`.
12. Wire the page script to `orpc.links.shorten`.
13. Add loading, success, error, copied, and QR states.
14. Add reduced-motion CSS.
15. Test desktop layout.
16. Test mobile layout.
17. Test keyboard-only interaction.
18. Test backend unavailable state.

## Frontend Acceptance Criteria

Functional:

- User can submit a valid URL.
- User sees the generated short URL.
- User can copy the generated short URL.
- Copy state changes to `Copied`.
- User can generate a QR code.
- QR encodes the short URL.
- Empty input shows friendly error.
- Invalid URL shows friendly error.
- Backend/network failure shows friendly error.

Visual:

- The first viewport contains the actual tool.
- No gradients.
- No glowing effects.
- No decorative blobs or generated-looking background art.
- No overuse of cards.
- No nested cards.
- The page feels calm, sparse, and professional.
- Spacing and alignment are deliberate.
- Text does not overflow buttons, inputs, or panels.
- Long URLs do not break layout.

Accessibility:

- Form is keyboard usable.
- Focus states are visible.
- Errors are announced or clearly associated.
- Result state is announced politely.
- Contrast passes AA.
- Reduced motion is respected.

Performance:

- No heavy UI library.
- No animation library.
- QR logic is lazy-loaded.
- Minimal client JavaScript.
- Build succeeds.

## Frontend Quality Gates

Run:

```bash
pnpm check
pnpm check-types
pnpm build
```

Manual browser verification:

- Desktop viewport around 1440px wide.
- Laptop viewport around 1280px wide.
- Tablet viewport around 768px wide.
- Mobile viewport around 390px wide.
- Keyboard-only flow.
- Reduced-motion mode.
- Backend offline or invalid `PUBLIC_SERVER_URL`.

Visual review checklist:

- Does it look like a serious utility, not a template?
- Is the shortener usable immediately?
- Is there any gradient, glow, blob, or flashy effect?
- Are there too many cards?
- Does every visible element have a job?
- Would the UI still feel polished if viewed with no animation?

## Frontend Non-Goals

Do not build these in v1:

- Dashboard
- Link history
- Account navigation
- Pricing page
- Feature grid
- Testimonials
- Analytics charts
- Custom alias controls
- Domain picker
- QR customization
- QR download
- Theme picker
- Mobile app styling system
- Browser extension UI

The frontend should feel simple because it is focused, not because it is unfinished.
