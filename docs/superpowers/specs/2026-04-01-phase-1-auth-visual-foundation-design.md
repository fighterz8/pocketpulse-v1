# PocketPulse Phase 1 Auth Visual Foundation Design

**Date:** 2026-04-01  
**Status:** Approved visual design baseline  
**Phase:** Phase 1  
**Scope:** `Auth` and `AccountSetup` only

## 1. Purpose
This document captures the approved visual direction for the Phase 1 unauthenticated and onboarding-facing screens. Its purpose is to establish a stronger visual identity for PocketPulse while keeping the implementation scope limited to `Sign in` and `Account setup`.

The approved direction is intended to do two things at once:
- improve screenshot and presentation quality for Phase 1
- establish a reusable visual language that can later influence the rest of the application

## 2. In Scope
- `client/src/pages/Auth.tsx`
- `client/src/pages/AccountSetup.tsx`
- shared styling in `client/src/index.css` needed to support these screens

## 3. Out of Scope
- protected shell redesign
- dashboard, upload, ledger, and leaks page redesign
- dark mode implementation
- animation-heavy hero experiences
- product-copy expansion beyond the minimum needed for orientation

## 4. Approved Direction
The approved direction is a **bright premium editorial interface** with a strong visual atmosphere.

It should feel:
- polished
- memorable
- trustworthy
- modern
- visually distinct enough to impress in a capstone setting

It should not feel:
- generic SaaS
- overly instructional
- flat or placeholder-like
- dark-tech by default

## 5. Core Visual Principles
### 5.1 Minimal messaging
The user does not need explanatory onboarding copy at this point. Messaging should be concise and mostly limited to:
- product label or brand marker
- clear screen title
- concise action labels

### 5.2 Stronger background treatment
The background should be more than a flat neutral color. It should use layered color, depth, and texture so the screen feels designed rather than merely functional.

Approved background qualities:
- bright overall presentation
- layered gradients or radial light fields
- subtle grid, texture, or depth cues
- enough contrast for the card to read clearly

### 5.3 Premium card treatment
The form container should feel like a designed object rather than a basic box.

Approved card qualities:
- larger radius
- stronger shadow treatment
- semi-translucent or glass-like surface if readability remains strong
- more deliberate internal spacing

### 5.4 Clean hierarchy
The screens should rely on:
- a clear product label
- a strong title
- restrained supporting copy
- disciplined field and button spacing

## 6. Color Direction
The approved palette direction is **bright blue-led premium finance**.

Guidelines:
- keep the overall composition brighter than the darker visual exploration
- use blue/cyan as the primary accent family
- allow subtle secondary color cues where useful
- maintain high legibility for inputs, buttons, and headings

This direction should leave room for a future dark mode without making the light mode feel like a compromise.

## 7. Layout Direction
The approved layout remains a centered single-panel composition for both screens.

Why this remains the right choice:
- it keeps implementation risk low in Phase 1
- it improves screenshot composition
- it is easy to reuse as a design baseline
- it avoids creating a polished auth page that is structurally inconsistent with the current rest of the app

## 8. Screen-Specific Intent
### 8.1 Sign in
The `Sign in` screen should communicate confidence and product maturity with very little text. The focus should be on the visual frame, the title, and the form itself.

### 8.2 Account setup
The `Account setup` screen should inherit the same visual system so onboarding feels like a continuation of the same product experience, not a separate utility page.

## 9. Reuse Across Later Screens
This visual pass is intended to establish patterns that can later influence:
- panel styling
- spacing rhythm
- title scale
- accent color usage
- input/button treatment
- background depth treatment for major app surfaces

It does **not** require those later screens to match the auth screens exactly. It establishes the tone and component language, not a locked full-app template.

## 10. Constraints
- keep functionality unchanged
- do not alter routing or auth behavior
- keep forms readable and accessible
- avoid overloading the screen with marketing content
- keep the implementation realistic for the current codebase

## 11. Deferred Work
The following are intentionally deferred:
- dark mode
- full protected-shell visual redesign
- broader component system extraction
- richer motion design
- app-wide typography overhaul

## 12. Recommendation
Implement this approved visual foundation as a focused Phase 1 polish pass on `Auth` and `AccountSetup`, then use the resulting design language as a reference point for later app-wide visual improvements.
