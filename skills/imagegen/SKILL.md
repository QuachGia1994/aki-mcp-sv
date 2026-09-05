---
name: aki-imagegen
description: Route concept art, artwork, mockups, logos, icons, splash screens, image generation, and image editing to the current host's native image-generation/editing capability when available.
---

# Aki ImageGen

Use this skill when the user asks to create, draw, design, render, visualize, generate, restyle, or edit an image, or asks for a visual concept/artwork/mockup such as UI concept art, logo, icon, splash, poster, key art, or visual preview.

## Trigger

Load/apply for requests containing intent such as concept, artwork, mockup, visual, image, picture, generate image, edit image, redesign image, logo, icon, splash, poster, render, draw, or visualize. If the concept must be based on a current/live site, first apply `../browser/SKILL.md` and use its verified evidence as the visual brief.

## Tool order

1. Prefer the current host's native image generation/editing tool. On a host that exposes a first-party ImageGen capability, call that capability directly rather than trying to route image synthesis through Aki MCP.
2. For an edit/retouch/restyle request, use the host-native image edit path against the actual image supplied in the current conversation when the host supports it.
3. Use Aki MCP only for local supporting context: brand specs, source assets already in the repo, UI code, dimensions, copy, or a written brief. Aki MCP itself does not magically provide another host's ImageGen engine.
4. If the current host has no native image-generation/editing capability, state that limitation. Do not substitute unrelated web images or claim an image was generated when no image tool ran.

## Concept workflow

- Convert repo/live evidence into a concise visual brief: target platform/viewport, hierarchy, brand elements, required copy, key components, and constraints.
- Generate the visual when the user asked for a visual output. Do not stop at prose or tool-argument JSON when a native image tool is available.
- Treat generated UI artwork as a concept reference, not proof that the live implementation matches it.
- For concept-vs-live work, preserve the browser findings that matter visually instead of inventing details from memory.

## Editing and identity

Follow the current host's image safety and identity rules. If the requested edit needs an actual source image that is not present/accessible, request that image instead of fabricating an unseen target.

## Output discipline

After a native image tool succeeds, follow the host's normal image-output behavior. Do not expose internal tool arguments, prompt JSON, or claim a local filesystem path unless the host actually provides one.
