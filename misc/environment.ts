/// <reference path="../node_modules/@types/chrome/index.d.ts" />
export function isInChromeExtension() {
    return typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id;
}
export function isInChromeExtensionBackground() {
    if (!isInChromeExtension()) return false;

    // Manifest V3: Service Worker context (has importScripts but no document)
    if (typeof (globalThis as any).importScripts === "function" && typeof document === "undefined") {
        return true;
    }

    // Manifest V2: Background page
    if (typeof chrome.extension !== "undefined" && typeof chrome.extension.getBackgroundPage === "function") {
        try {
            return chrome.extension.getBackgroundPage() === window;
        } catch (e) {
            return false;
        }
    }

    return false;
}
export function isInChromeExtensionContentScript() {
    return isInChromeExtension() && !isInChromeExtensionBackground();
}
export function isInElectron() {
    return typeof process !== "undefined" && process.versions && process.versions.electron;
}
let isInBuildFlag = false;
export function triggerIsInBuild() {
    isInBuildFlag = true;
}
export function isInBuild() {
    return isInBuildFlag;
}
export function isInBrowser() {
    return typeof document !== "undefined";
}