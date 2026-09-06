---
name: aki-icon-silhouette
description: Build app icons from a clean silhouette/glyph foreground and platform-correct background/masking so launcher icons never ship with baked white square corners, accidental padding, duplicate rounded masks, or raster halos. Covers iOS/iPadOS, Android adaptive icons, Expo, Tauri mobile, and generated artwork handoff.
---

# Aki Icon Silhouette

Use this skill whenever creating, replacing, exporting, reviewing, or wiring an app icon, launcher icon, adaptive icon, monochrome/themed icon, logo mark, splash mark, or generated brand asset into a mobile project.

The key rule is **silhouette-first, container-second**: the brand mark/glyph should exist as its own clean foreground shape, normally with transparency around it. Platform background and masking are separate concerns. Never take a padded white-square logo export and treat that square as the launcher foreground.

## Trigger

Load/apply for AppIcon, `ic_launcher`, adaptive icon, Expo `icon`/`adaptiveIcon`, Tauri mobile icons, logo-to-app-icon conversion, splash/logo export, or when the user mentions square white borders/corners, wrong launcher shape, icon padding, halo, jagged mask, or Android-vs-iOS icon mismatch.

If artwork must be generated or edited, also load `../imagegen/SKILL.md`. Generate the mark as a transparent silhouette/source layer first, then derive platform assets from it.

## Source artwork contract

Keep at least these conceptual assets separate:

1. **Foreground mark / silhouette** — clean logo/glyph, transparent around the mark, no white canvas, no baked rounded rectangle, no drop-shadow halo at the outer icon boundary.
2. **Background** — solid/gradient/full-bleed platform background where the platform requires one.
3. **Monochrome mark** — single-shape version suitable for Android themed icons and other tintable surfaces when supported.

Prefer vector/SVG/PDF source for the mark when the platform/toolchain accepts it. Raster exports must preserve alpha around the silhouette and must not introduce matte-white edge pixels.

Do not infer transparency from the image looking white-on-white in a preview. Inspect the alpha channel or preview against a contrasting checkerboard/background.

## Android adaptive icon

Follow the Android adaptive-icon contract instead of shipping a pre-rounded bitmap:

- Use separate `<foreground>` and `<background>` layers; provide `<monochrome>` where supported.
- Design the foreground inside the adaptive safe region; keep critical content centered and away from OEM mask edges.
- Current Android guidance uses a 108×108 dp layer canvas, with the inner 66×66 dp area guaranteed against clipping; keep the logo itself within that safe region and large enough to remain legible.
- Foreground corners/outer canvas should be transparent unless the mark genuinely fills them. The background layer supplies the full-bleed color/image.
- Do **not** bake a circular/squircle/rounded-square mask or outer white square into the foreground. The launcher/OEM applies its own mask.
- Do not add an outer shadow or feathered edge that assumes a specific launcher shape; it produces halos when another OEM mask is applied.
- Wire both `android:icon` and `android:roundIcon` through the proper mipmap/adaptive resources when the native project expects them.

### Expo / React Native

When Expo config owns launcher assets:

- Treat `icon` as the platform fallback/source, not permission to reuse a padded white-square PNG everywhere.
- Configure `android.adaptiveIcon.foregroundImage` from the transparent silhouette asset.
- Configure `android.adaptiveIcon.backgroundColor` or background image separately.
- Provide `android.adaptiveIcon.monochromeImage` when the installed Expo SDK supports/needs themed icons.
- Check generated native resources after prebuild/build if launcher appearance is important; config that looks correct can still point to the wrong file.

Do not solve an Android white-corner bug by manually rounding the PNG. That hides one launcher shape and breaks others.

## iOS / iPadOS 27+

Apple app-icon assets are not Android adaptive foregrounds. For iOS/iPadOS/macOS, provide square, **unmasked** icon layers/source and let the system apply the final rounded shape.

- Do not bake rounded corners into the source asset; double masking causes uneven/jagged edges and bad Liquid Glass effects.
- Keep the icon background full-bleed. A white margin around a smaller rounded icon is a real white-square artifact, not a safe area.
- With Icon Composer/current layered icons, use a clearly defined foreground silhouette/vector layer and a separate background. Let the system supply highlights/refraction/shadows instead of baking a launcher-edge effect into the artwork.
- Center primary content so system corner treatment does not clip it.
- Keep dark/tinted/clear variants coherent with the same mark geometry rather than independently redrawing silhouettes.

Important distinction: the **foreground mark** can have transparent surroundings, but the final ordinary iOS app-icon composition/background is typically full-bleed. Do not make the whole final iOS icon transparent just to imitate Android foreground behavior.

## Tauri v2 mobile

Tauri may generate/copy launcher assets into platform projects, but the platform contracts still apply:

- Inspect the generated Android `mipmap`/adaptive-icon resources instead of assuming a single Tauri source PNG preserves adaptive layers.
- Inspect the generated Xcode AppIcon/Icon Composer assets for iOS.
- If one cross-platform source produces padded white-square Android results, split the Android adaptive foreground/background from the iOS full composition rather than forcing one raster to serve both contracts.

## Splash/loading logo

Splash marks should also use the clean silhouette/source artwork, but splash-background behavior is independent from launcher masking. Do not reuse an opaque app-icon square as the splash logo when the design calls for a floating mark; export the silhouette with alpha and place it on the splash background separately.

## Verification gate

Before declaring an icon fix complete:

1. Confirm the source foreground has real alpha outside the silhouette; no white matte corners/edge pixels.
2. Confirm no pre-rounded mask exists where the OS/launcher applies the mask.
3. Confirm Android adaptive foreground/background/monochrome references point to the intended assets.
4. Confirm iOS AppIcon/Icon Composer receives square unmasked/full-bleed composition/layers, not a white-padded rounded bitmap.
5. Build/install and inspect the icon on at least one real Android launcher and the target iOS simulator/device when those platforms are in scope. Android OEM masks differ; a single desktop preview is not enough for a launcher-shape bug.
6. Check small-size legibility in Settings/notifications/search where the platform displays reduced variants.

If physical-device verification was not run, say so explicitly instead of claiming the square-corner issue is fully closed.

## Handoff

For mobile stack/navigation constraints, also load `../mobile-native/SKILL.md`. For implementation discipline, load `../anti-vibecoding/SKILL.md`; for generated artwork, `../imagegen/SKILL.md` owns the actual image-generation/edit path.