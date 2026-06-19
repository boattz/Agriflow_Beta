---
name: Agriflow
description: IoT soil moisture monitoring dashboard for home gardeners
colors:
  primary: "#38eb9c"
  primary-dim: "#1a7a52"
  secondary: "#38d9f5"
  secondary-dim: "#1a6a7a"
  warning: "#f5a623"
  error: "#ff5c6c"
  purple: "#b47cff"
  bg: "#040810"
  surface: "#0a1120"
  surface-raised: "#0e1628"
  text: "#e8f4f0"
  text-muted: "#4a6868"
  border: "rgba(56,235,156,0.08)"
  border-strong: "rgba(56,235,156,0.15)"
typography:
  body:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  display:
    fontFamily: "JetBrains Mono, Fira Code, monospace"
    fontSize: "clamp(2.4rem, 8vw, 4rem)"
    fontWeight: 800
    lineHeight: 1
  label:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "0.6rem"
    fontWeight: 600
    letterSpacing: "0.1em"
    textTransform: "uppercase"
rounded:
  sm: "12px"
  md: "18px"
  lg: "24px"
  full: "100px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  card:
    backgroundColor: "linear-gradient(145deg, rgba(10,17,32,0.9), rgba(14,22,40,0.7))"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "24px"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#000"
    rounded: "{rounded.full}"
    padding: "9px 18px"
  chip:
    backgroundColor: "rgba(56,235,156,0.06)"
    textColor: "{colors.text}"
    rounded: "{rounded.full}"
    padding: "5px 14px"
---

# Design System: Agriflow

## 1. Overview

**Creative North Star: "The Digital Greenhouse"**

Agriflow brings the clarity of a well-tended garden to digital monitoring. The design language is clean, technical, and nature-connected, avoiding both industrial complexity and playful whimsy. Every element serves a purpose: showing soil health, valve status, and moisture trends without overwhelming non-technical users.

**Key Characteristics:**
- Dark, deep background with luminous accents that feel alive
- Monospace data values for precision, sans-serif for readability
- Organic curves (18-24px radius) that feel approachable, not clinical
- Status-driven color: green for healthy, red for alerts, orange for warnings
- Mobile-first layout optimized for outdoor use

## 2. Colors

The palette balances technical precision with natural warmth. Primary green carries the "healthy plant" signal; cool grays provide the technical backdrop.

### Primary
- **Living Mint** (#38eb9c): Active states, healthy readings, primary actions, moisture indicators
- **Deep Mint** (#1a7a52): Dimmed primary for borders, subtle backgrounds

### Secondary
- **Electric Cyan** (#38d9f5): Secondary data (raw ADC), chart accents, focus rings
- **Deep Cyan** (#1a6a7a): Dimmed secondary

### Tertiary
- **Amber** (#f5a623): Warnings, threshold indicators, countdown approaching zero
- **Coral** (#ff5c6c): Errors, offline states, critical alerts
- **Soft Purple** (#b47cff): Tertiary accents (used sparingly)

### Neutral
- **Void** (#040810): Page background, deepest layer
- **Surface** (#0a1120): Card backgrounds, raised elements
- **Surface Raised** (#0e1628): Hover states, elevated cards
- **Text Primary** (#e8f4f0): Body text, headings
- **Text Muted** (#4a6868): Labels, secondary info, disabled states
- **Border** (rgba(56,235,156,0.08)): Default card borders
- **Border Strong** (rgba(56,235,156,0.15)): Hover/focus borders

### Named Rules
**The Signal Rule.** Color carries meaning: green = healthy/active, red = alert/offline, orange = warning/approaching. Never use these colors decoratively; they must always map to a system state.

## 3. Typography

**Display Font:** JetBrains Mono (with Fira Code fallback)
**Body Font:** DM Sans (with system-ui fallback)

**Character:** Technical precision meets approachable readability. Monospace for data values signals accuracy; sans-serif for body text keeps things friendly and scannable.

### Hierarchy
- **Display** (800 weight, clamp(2.4rem, 8vw, 4rem), line-height 1): Moisture percentage, key metrics
- **Headline** (700 weight, 1.5rem, line-height 1): Card titles, section headers
- **Body** (400 weight, 1rem, line-height 1.6): Descriptions, labels, content
- **Label** (600 weight, 0.6rem, letter-spacing 0.1em, uppercase): Category tags, section eyebrows
- **Mono** (400-700 weight, 0.72-1.6rem): Data values, timestamps, technical readouts

### Named Rules
**The Data Rule.** All sensor values, timestamps, and technical readouts use monospace. All human-readable text uses DM Sans. Never mix.

## 4. Elevation

The system uses soft, ambient shadows for depth. Cards float above the void background with subtle lifts. Shadows appear on hover and focus to signal interactivity, not as permanent decoration.

### Shadow Vocabulary
- **Ambient** (`box-shadow: 0 8px 40px rgba(0,0,0,0.2)`): Card hover states, elevated elements
- **Glow** (`box-shadow: 0 0 20px rgba(56,235,156,0.25)`): Active/healthy status indicators
- **Alert** (`box-shadow: 0 0 12px rgba(255,92,108,0.2)`): Error/offline states

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest. Shadows appear only as a response to state (hover, elevation, focus). The void background provides depth without needing constant shadow presence.

## 5. Components

### Cards
- **Corner Style:** Gently curved (24px radius)
- **Background:** Gradient from surface to surface-raised
- **Border:** 1px solid border color, strong on hover
- **Internal Padding:** 24px (desktop), 16px (mobile)
- **States:** Flat at rest, subtle lift on hover

### Buttons
- **Shape:** Full pill (100px radius)
- **Primary:** Green background, black text, 9px 18px padding
- **Hover:** Scale 1.05, glow shadow
- **Ghost:** Transparent with border, text color

### Chips / Tags
- **Style:** Pill-shaped, tinted background matching status color
- **State:** Solid fill for active, outline for inactive

### Inputs / Sliders
- **Style:** 6px track, circular thumb (22px)
- **Focus:** 3px blue outline, 4px offset
- **Thumb Colors:** Orange for threshold, cyan for duration

### Navigation (Header)
- **Style:** Floating pill dock with backdrop blur
- **Background:** Semi-transparent surface with glassmorphism
- **Border:** 1px solid border color

### Status Indicators
- **Dot:** 8px circle, color-coded (green/orange/red)
- **Pulse Animation:** Glow effect on active states
- **Offline Badge:** Red tinted pill with "OFFLINE" text

## 6. Do's and Don'ts

### Do:
- **Do** use green for healthy/active states and red for alerts consistently
- **Do** keep data values in monospace for technical precision
- **Do** use 24px border-radius on cards for approachable curves
- **Do** test readability in outdoor/sunlight conditions
- **Do** provide 44px minimum touch targets for mobile use

### Don't:
- **Don't** use color decoratively; every color must map to a system state
- **Don't** add complex enterprise SCADA/PLC dashboard patterns
- **Don't** use glassmorphism everywhere; reserve for the header dock only
- **Don't** show all data at once; use progressive disclosure
- **Don't** use gradient text or decorative side-stripe borders
