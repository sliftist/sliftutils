import { SerializedModule } from "./bundleWrapper";

// Sets globalThis.require = ..., utilizing registeredModules (from bundleWrapper.ts) when require is called
export interface BundleRequireConfig {
    rootPath: string;
}
export function bundleRequire(config: BundleRequireConfig) {
    globalThis.process = globalThis.process || {
        env: {
            NODE_ENV: "production",
        },
        versions: {},
        on: () => { },
    };
    // Use production, for consistency (and so mobx doesn't break)
    globalThis.process.env.NODE_ENV = globalThis.process.env.NODE_ENV || "production";
    (globalThis as any).window = (globalThis as any).window || globalThis;
    (globalThis as any).global = (globalThis as any).global || globalThis;
    (globalThis as any).setImmediate = (globalThis as any).setImmediate || globalThis.setTimeout;

    (globalThis as any).BOOTED_EDGE_NODE = undefined;

    let builtInModuleExports: { [key: string]: unknown } = {
        worker_threads: {
            isMainThread: true,
        },
        util: {
            // https://nodejs.org/api/util.html#util_util_inherits_constructor_superconstructor
            inherits(constructor: any, superConstructor: any) {
                Object.setPrototypeOf(constructor.prototype, superConstructor.prototype);
            },
            TextDecoder: TextDecoder,
            TextEncoder: TextEncoder,
        },
        buffer: { Buffer },
        stream: {
            // HACK: Needed to get SAX JS to work correctly.
            Stream: function () { },
            Transform: function () { },

            Writable: function () { },
        },
        timers: {
            // TODO: Add all members of timers
            setImmediate: globalThis.setImmediate,
        },
        child_process: {},
        events: class EventEmitter { },
    };
    if (typeof require !== "undefined") {
        const builtInRequire = require;
        let allBuiltInModules = new Set<string>();
        allBuiltInModules.add("electron");
        allBuiltInModules.add("original-fs");
        allBuiltInModules.add("vscode");
        try {
            // Change the builts ins to use the actual built ins!
            let { builtinModules } = require("node:module");
            for (let key of builtinModules) {
                allBuiltInModules.add(key);
            }
        } catch { }

        for (let key of allBuiltInModules) {
            Object.defineProperty(builtInModuleExports, key, {
                get() {
                    return builtInRequire(key);
                },
            });
        }
    }

    // Just path.resolve (but needs to be reimplemented, because we can't use imports)
    function pathResolve(...paths: string[]): string {
        // Start with empty path segments array
        let segments: string[] = [];
        let isWindowsPath = false;

        paths = paths.map(x => x.replace(/\\/g, "/"));

        // Process each path argument
        for (const path of paths) {
            // Check for Windows drive letter (e.g., C:/)
            if (/^[A-Za-z]:/.test(path)) {
                isWindowsPath = true;
                // Remove drive letter for processing
                const withoutDrive = path.slice(2);
                if (withoutDrive.startsWith("/")) {
                    segments = [path.slice(0, 2)]; // Keep drive letter and reset segments
                } else {
                    // If no leading slash, keep current segments (relative to current drive path)
                    if (segments.length === 0 || !segments[0].match(/^[A-Za-z]:/)) {
                        segments = [path.slice(0, 2)];
                    }
                }
                // Add the rest of the path parts
                segments.push(...withoutDrive.split("/").filter(x => x));
                continue;
            }

            // If absolute path, reset segments but keep drive letter if present
            if (path.startsWith("/")) {
                if (isWindowsPath && segments.length > 0 && segments[0].match(/^[A-Za-z]:/)) {
                    const drive = segments[0];
                    segments = [drive];
                } else {
                    segments = [];
                }
            }

            // Split path into segments and process each
            const pathParts = path.split("/").filter(x => x);
            for (const part of pathParts) {
                if (part === "..") {
                    // Don't pop off the drive letter
                    if (segments.length > (isWindowsPath ? 1 : 0)) {
                        segments.pop();
                    }
                } else if (part !== ".") {
                    // Add segment if not current directory marker
                    segments.push(part);
                }
            }
        }

        // Combine segments into final path
        let result = segments.join("/");
        if (!isWindowsPath) {
            result = "/" + result;
        }
        return result;
    }
    function dirname(path: string): string {
        return path.split("/").slice(0, -1).join("/");
    }

    const requireCache: { [id: string]: NodeJS.Module } = {};

    let rootModule = createModule({
        parentModule: undefined,
        resolveAbsolutePath: config.rootPath + "/rootPlaceholder",
    });
    globalThis.require = rootModule.require as any;

    function createModule(config: {
        parentModule: NodeJS.Module | undefined;
        resolveAbsolutePath: string;
    }): NodeJS.Module {
        const { parentModule, resolveAbsolutePath } = config;
        let cached = requireCache[resolveAbsolutePath];
        if (cached) {
            return cached;
        }
        let serialized = globalThis.registeredModules?.[resolveAbsolutePath];

        let newModule: NodeJS.Module = {
            id: resolveAbsolutePath,
            filename: resolveAbsolutePath,
            exports: {},
            parent: parentModule,
            children: [],
            isPreloading: false,
            loaded: false,
            path: dirname(resolveAbsolutePath),
            paths: serialized?.paths || [],
            require: requireFnc,
            load,
        } as any;
        newModule.exports.default = newModule.exports;
        if (parentModule) {
            parentModule.children.push(newModule);
        }
        for (let [key, value] of Object.entries(serialized?.moduleFields || {})) {
            if (key in newModule) continue;
            (newModule as any)[key] = value;
        }
        resolve.paths = (request: string) => [];

        requireCache[newModule.id] = newModule;
        requireFnc.resolve = resolve;
        requireFnc.cache = requireCache;
        requireFnc.main = newModule;
        requireFnc.extensions = "extension not implemented yet" as any;

        // Resolves file extensions
        function innerResolve(path: string): string {
            let candidates = [
                path,
                path + ".js",
                path + ".ts",
                path + ".tsx",
            ];
            for (let candidate of candidates) {
                let registered = globalThis.registeredModules?.[candidate];
                if (registered) {
                    return registered.id;
                }
            }
            return path;
        }

        function resolve(path: string): string {
            path = path.replace(/\\/g, "/");
            if (path.startsWith(".")) {
                return innerResolve(pathResolve(newModule.path, path));
            }
            // We need to search all paths
            for (let searchRoot of serialized?.paths || []) {
                let candidate = innerResolve(pathResolve(searchRoot, path));
                let registered = globalThis.registeredModules?.[candidate];
                if (registered) {
                    return registered.id;
                }
            }
            // It is probably "fs" or something like that
            return path;
            // debugger;
            // throw new Error(`Module ${path} not found`);
        }

        function requireFnc(path: string) {
            if (path in builtInModuleExports) {
                return builtInModuleExports[path as keyof typeof builtInModuleExports];
            }
            let resolved = resolve(path);
            let subModule = createModule({
                parentModule: newModule,
                resolveAbsolutePath: resolved,
            }) as any;
            subModule.load(newModule.filename);
            return subModule.exports;
        }

        function load() {
            if (newModule.loaded) return;
            // NOTE: Set loaded immediately, in case we have a circular dependency
            newModule.loaded = true;

            if (serialized) {
                serialized.moduleFnc(newModule.exports, requireFnc, newModule, newModule.filename, newModule.path);
            } else {
                // If we are being imported by the root module, we need to throw an error
                if (!config.parentModule?.parent) {
                    debugger;
                    throw new Error(`Could not find required module ${JSON.stringify(config.resolveAbsolutePath)}, have ${JSON.stringify(Object.keys(globalThis.registeredModules || {}))}`);
                }
                newModule.exports = new Proxy(
                    {},
                    {
                        get(target, property) {
                            if (property === "__esModule") return undefined;
                            if (property === "default") return newModule.exports;

                            console.warn(
                                `Module ${newModule.filename} is not available. It might have not been imported in Node.js due to a flag which is checking the browser or an environment variable. It might also be that the entry point is weirdly configured and could not be detected.`
                            );
                            return undefined;
                        },
                    }
                );
            }
        }

        return newModule;
    }
}