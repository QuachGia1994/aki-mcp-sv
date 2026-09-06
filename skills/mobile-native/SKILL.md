---
name: aki-mobile-native
description: Route mobile app UI/navigation work through the project's real native stack: SwiftUI/iOS 27+ system TabView and bottom navigation, Expo Router NativeTabs for React Native, or Tauri v2 mobile with React plus native Kotlin/Swift plugins where required. Preserve the existing stack and avoid fake custom system chrome.
---

# Aki Mobile Native

Use this skill for iOS/Android app architecture, bottom navigation, tabs, mobile UI, Expo/React Native, SwiftUI/UIKit, Tauri mobile, safe areas, keyboard behavior, native permissions, and platform-specific UX.

## Trigger and stack detection

Before coding, identify the stack from the repo rather than from the request wording: Xcode/Swift files → Apple native; `expo`/`expo-router` → Expo React Native; `src-tauri`/Tauri config → Tauri v2; Gradle/Compose without those → native Android. Preserve that stack unless the user explicitly asks for a migration.

Use current installed versions as the source of truth. Mobile navigation APIs move quickly, especially Expo Router NativeTabs, so verify the repo SDK/framework version and current upstream docs before selecting an API.

## iOS 27+ native bottom navigation

For SwiftUI apps targeting iOS 27+, default to the system navigation containers rather than drawing a custom floating bottom bar:

- Use `TabView` + `Tab` for top-level destinations and system SF Symbols for tab icons. Prefer outline symbols; the system supplies selected-state treatment.
- Let the OS render the current Liquid Glass tab/navigation appearance. Do not recreate system glass with custom blur/opacity layers when a native bar already exists.
- Use `TabRole.search` for a real search destination when appropriate instead of a hand-built detached search capsule.
- Use `tabBarMinimizeBehavior` when the product calls for scroll-driven tab-bar minimization.
- Use `tabViewBottomAccessory` for media/status/mini-player content that belongs above or inline with the tab bar; adapt its content to the system-reported placement.
- Keep navigation state in the app model and use `NavigationStack` inside tabs for drill-down flows. Top-level tab identity and pushed navigation are different state domains.
- Build and test with Xcode 27/current SDK when using iOS 27-only APIs. If the deployment target is older, gate availability and preserve the native fallback rather than shipping a fake iOS 27 bar.

Audit Dynamic Type, VoiceOver labels, Reduce Motion/Transparency, safe areas, keyboard transitions, landscape/resizable scenes, dark/light mode, and real-device back/swipe behavior. The bar looking native is not sufficient if these states break.

## Expo / React Native

When the repo uses Expo Router, prefer platform-native tabs through `expo-router/unstable-native-tabs` when the installed SDK supports the required behavior. Treat the API as version-sensitive/unstable: read the current Expo docs/changelog and do not paste an example from another SDK blindly.

- Keep routes in Expo Router layouts; use NativeTabs for true system tabs when system behavior is desired.
- On modern Expo SDKs, use Expo Router's supported navigation integration rather than importing internal React Navigation packages directly unless the installed version requires it.
- On iOS 27+, allow the native tab host to pick up system Liquid Glass behavior instead of styling a JS imitation.
- On Android, verify safe-area and IME behavior on-device. Use the current NativeTabs keyboard/inset options only when supported by the repo SDK.
- Do not confuse React Native with a web React implementation. A custom React Native tab bar is still app-rendered UI; choose it only when product requirements genuinely cannot be expressed through system tabs.

Known upstream NativeTabs issues can be release-specific, so a bug report is evidence to test the installed version, not a permanent workaround mandate.

## Tauri v2 mobile + React

Tauri with React renders the frontend in a system webview; it is not React Native and a React bottom bar is not a native `UITabBarController`/Android system navigation component.

- Use Tauri v2's normal React/Vite SPA architecture for the webview UI and `tauri android dev/build` or `tauri ios dev/build` for mobile targets.
- Use Tauri mobile plugins for capabilities that need native APIs. Android plugin code belongs in Kotlin/Java; iOS plugin code belongs in Swift, bridged through the Tauri plugin boundary.
- Keep permissions/capabilities least-privileged and platform-scoped. Do not expose a broad Rust command merely because a frontend button needs one native operation.
- If the user requires genuinely native iOS system tabs/navigation, say plainly that a webview-rendered Tauri React tab bar does not satisfy that requirement. Do not silently migrate the project; recommend the existing native/Expo path only when the product requirement justifies it.
- Test Android back behavior, keyboard/IME, deep links, lifecycle restoration, runtime permissions, external-link behavior, and WebView/dev-server differences on real devices where the feature depends on platform behavior.

## Native Android fallback

If the repo is native Kotlin/Compose, use current Android navigation/Material components rather than introducing Expo or Tauri. Keep system back/gesture handling, edge-to-edge insets, IME, lifecycle, and state restoration as first-class acceptance criteria.

## Cross-platform rule

Share domain logic and design tokens when useful; do not force identical navigation implementation across Apple native, React Native, and Tauri. The user experience can be consistent while each platform keeps its real navigation contract.

If the task also asks for the smallest implementation, load `../ponytail/SKILL.md`. For any nontrivial mobile implementation, apply `../anti-vibecoding/SKILL.md` before declaring it converged. For app icons, launcher assets, splash marks, or square-white-corner bugs, load `../icon-silhouette/SKILL.md`. For a visual concept, use `../imagegen/SKILL.md` only after the platform/navigation constraints above are fixed.
