---
name: Synthetix AI
colors:
  surface: '#111318'
  surface-dim: '#111318'
  surface-bright: '#37393e'
  surface-container-lowest: '#0c0e12'
  surface-container-low: '#1a1c20'
  surface-container: '#1e2024'
  surface-container-high: '#282a2e'
  surface-container-highest: '#333539'
  on-surface: '#e2e2e8'
  on-surface-variant: '#bbc9cf'
  inverse-surface: '#e2e2e8'
  inverse-on-surface: '#2f3035'
  outline: '#859399'
  outline-variant: '#3c494e'
  surface-tint: '#4cd6ff'
  primary: '#a4e6ff'
  on-primary: '#003543'
  primary-container: '#00d1ff'
  on-primary-container: '#00566a'
  inverse-primary: '#00677f'
  secondary: '#d6baff'
  on-secondary: '#430089'
  secondary-container: '#6205c3'
  on-secondary-container: '#cba9ff'
  tertiary: '#d8dce6'
  on-tertiary: '#2c3138'
  tertiary-container: '#bcc0ca'
  on-tertiary-container: '#494e57'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#b7eaff'
  primary-fixed-dim: '#4cd6ff'
  on-primary-fixed: '#001f28'
  on-primary-fixed-variant: '#004e60'
  secondary-fixed: '#ecdcff'
  secondary-fixed-dim: '#d6baff'
  on-secondary-fixed: '#280057'
  on-secondary-fixed-variant: '#6000bf'
  tertiary-fixed: '#dee2ec'
  tertiary-fixed-dim: '#c2c7d0'
  on-tertiary-fixed: '#171c23'
  on-tertiary-fixed-variant: '#42474f'
  background: '#111318'
  on-background: '#e2e2e8'
  surface-variant: '#333539'
  surface-card: '#161B22'
  surface-background: '#0A0C10'
  electric-cyan: '#00D1FF'
  vivid-purple: '#9D5BFF'
  border-subtle: '#30363D'
  text-primary: '#F0F6FC'
  text-secondary: '#8B949E'
typography:
  headline-xl:
    fontFamily: Inter
    fontSize: 40px
    fontWeight: '700'
    lineHeight: 48px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-lg-mobile:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  label-md:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
    letterSpacing: 0.02em
  label-sm:
    fontFamily: Geist
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.05em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  base-unit: 4px
  gutter: 24px
  margin-mobile: 16px
  margin-desktop: 32px
  container-max-width: 1440px
---

## Brand & Style

This design system is built for a professional AI image generation environment where technical precision meets creative flow. The brand personality is **technical, efficient, and premium**, designed to feel like a high-performance tool rather than a casual toy.

The chosen design style is **Corporate / Modern** with a strong influence from **Minimalism** and **Glassmorphism**. By utilizing a deep, dark palette, the UI recedes into the background, allowing the generated creative assets to take center stage. High-fidelity translucent layers and vibrant accent blurs provide a sense of depth and "digital craft" without distracting the user from their workflow. The target audience includes professional creators and developers who value speed, consistency, and a refined aesthetic.

## Colors

The palette is anchored in a deep charcoal and navy base to minimize eye strain during long creative sessions. 

- **Primary (Electric Cyan):** Reserved for high-priority actions, generation triggers, and active states. It represents the "spark" of AI creation.
- **Secondary (Electric Purple):** Used for secondary accents, progress indicators, or premium feature highlights.
- **Tertiary & Neutral:** These shades form the structural foundation. `#0A0C10` is used for the primary canvas, while `#161B22` is used for elevated containers and sidebars.

Maintain a high contrast ratio for text elements by using `text-primary` for titles and `text-secondary` for descriptions and labels. Avoid using pure black to maintain a "premium matte" feel.

## Typography

This design system utilizes **Inter** for its exceptional legibility in dark environments and its neutral, modern tone. For technical metadata and UI labels, **Geist** is introduced to provide a "developer-friendly" monospaced character that reinforces the technical nature of AI parameter configuration.

- **Headlines:** Use tight letter-spacing and bold weights to create a strong visual hierarchy.
- **Labels:** Small caps or increased letter-spacing should be used for `label-sm` to ensure readability on dark surfaces.
- **Body:** Standardize on 16px for general inputs and 18px for prompt text areas to ensure comfortable typing.

## Layout & Spacing

The system follows a **Fixed Grid** philosophy for the main dashboard content to ensure generation results are framed consistently.

- **Desktop:** A 12-column grid with a 24px gutter. The sidebar for parameters is fixed at 320px, while the main generation canvas expands to fill the remaining space up to the 1440px container limit.
- **Mobile:** A 4-column fluid grid. The parameter sidebar collapses into a bottom sheet or a hidden drawer to prioritize the prompt input and image results.
- **Rhythm:** All spacing (padding, margins) must be multiples of the 4px base unit to maintain a rigorous mathematical harmony across the dashboard.

## Elevation & Depth

Depth is communicated through **Tonal Layers** and **Low-Contrast Outlines** rather than heavy shadows.

1.  **Background (Level 0):** `#0A0C10` – The base floor of the application.
2.  **Surface (Level 1):** `#161B22` – Used for the sidebar and card containers. These elements feature a subtle 1px border of `#30363D`.
3.  **Overlay (Level 2):** Floating menus or tooltips. These use a semi-transparent background with a `backdrop-filter: blur(12px)` to create a glassmorphic effect.

Shadows, if used, should be ultra-diffused: `0px 8px 24px rgba(0, 0, 0, 0.5)`.

## Shapes

The shape language is disciplined and professional. **Soft (0.25rem)** roundedness is the standard for functional elements like input fields and small buttons. Larger components like image cards and the prompt text area use **rounded-lg (0.5rem)**.

Avoid pill-shaped buttons for primary actions; instead, use the subtle 8px radius to maintain the "technical" aesthetic. Reference images and generated outputs should strictly follow the 8px corner radius to ensure the UI feels integrated.

## Components

### Buttons
- **Primary:** Background Cyan (#00D1FF), Text Black (#0A0C10), Bold weight. High-impact for the "Generate" action.
- **Secondary:** Transparent background with a Cyan or Purple border. 
- **Ghost:** No background, Secondary Text color. Used for history or settings.

### Input Fields (Prompt & Images)
- **Prompt Area:** Deep background (#0A0C10) with a 1px border (#30363D). On focus, the border glows with a soft Cyan pulse.
- **Image Upload:** Dashed border (#30363D) with a centered icon. Drag-and-drop states should trigger a purple highlight.

### Cards (Generation History)
- Cards should have a "locked" appearance for the hardcoded parameters (Model: Nano Banana 2). Use a "Lock" icon next to these labels to signify they are non-editable.
- Hovering over an image card should reveal a glassmorphic overlay with quick actions (Download, Copy Prompt, Delete).

### Chips & Badges
- Used for aspect ratio selection. Active state: Cyan background with black text. Inactive state: Navy background with white border.

### Checkboxes & Radios
- Modern, custom-styled. When checked, they should use a solid Cyan fill with a white checkmark.